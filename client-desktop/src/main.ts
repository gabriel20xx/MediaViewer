import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserWindow as BrowserWindowType } from 'electron';
import * as electron from 'electron';
import { SerialPort } from 'serialport';
import { isIP } from 'node:net';
import { SerialTCodeDriver } from './serialDriver.js';

const { app, BrowserWindow, ipcMain, powerSaveBlocker, session } = electron;

// Filter Chromium's noisy certificate warnings that we already handle above.
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk: unknown, encoding?: BufferEncoding | ((err?: Error) => void), callback?: (err?: Error) => void) => {
  const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === 'string' ? encoding : undefined) : String(chunk ?? '');
  const isNoisyCert =
    text.includes('CertVerifyProcBuiltin for') ||
    text.includes('cert_verify_proc_builtin.cc') ||
    text.includes('ssl_client_socket_impl.cc') ||
    text.includes('No matching issuer found') ||
    text.includes('----- Certificate i=') ||
    text.includes('handshake failed;');

  const isNoisyCache =
    text.includes('backend_impl.cc') && text.includes('Invalid cache') && text.includes('size');

  if (isNoisyCert || isNoisyCache) {
    if (typeof encoding === 'function') encoding();
    else if (typeof callback === 'function') callback();
    return true;
  }
  return originalStderrWrite(chunk as any, encoding as any, callback as any);
};

type Hostname = string;
type Port = number;

const ANY_PORT: Port = -1;
const allowedInsecureHosts = new Map<Hostname, Set<Port>>();

function addAllowedHost(hostname: string, port: Port | null): void {
  const entry = allowedInsecureHosts.get(hostname) ?? new Set<Port>();
  if (port != null && Number.isFinite(port)) entry.add(port);
  entry.add(ANY_PORT);
  allowedInsecureHosts.set(hostname, entry);
}

function isHostAllowed(hostname: string, port: Port | null | undefined): boolean {
  const entry = allowedInsecureHosts.get(hostname);
  if (!entry) return false;
  if (entry.has(ANY_PORT)) return true;
  if (port != null && Number.isFinite(port) && entry.has(port)) return true;
  return false;
}

function isLocalNetworkHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1') return true;
  const ipType = isIP(hostname);
  if (ipType === 4) {
    const parts = hostname.split('.').map((p) => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
    if (parts[0] === 10) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 127) return true;
    return false;
  }
  if (ipType === 6) {
    const lower = hostname.toLowerCase();
    if (lower === '::1') return true;
    if (lower.startsWith('fd') || lower.startsWith('fc')) return true;
    if (lower.startsWith('fe80:')) return true;
    return false;
  }
  return false;
}

function parseUrlHost(urlString: string): { hostname: string; port: Port | null } | null {
  try {
    const url = new URL(urlString);
    if (url.protocol !== 'https:' && url.protocol !== 'wss:') return null;
    const port = url.port ? Number.parseInt(url.port, 10) : null;
    return { hostname: url.hostname, port: Number.isFinite(port) ? port : null };
  } catch {
    return null;
  }
}

function setupCertificateHandling() {
  const defaultSession = session?.defaultSession;
  if (!defaultSession) return;

  defaultSession.setCertificateVerifyProc((request, callback) => {
    try {
      const reqPort = (request as { port?: number }).port;
      if (isLocalNetworkHost(request.hostname)) {
        addAllowedHost(request.hostname, reqPort ?? null);
        console.log(`[Main] Auto-trusting local certificate for ${request.hostname}:${reqPort ?? 'default'}`);
        callback(0);
        return;
      }
      if (isHostAllowed(request.hostname, reqPort)) {
        console.log(`[Main] Trusting certificate for ${request.hostname}:${reqPort ?? 'default'}`);
        callback(0);
        return;
      }
    } catch {
      // fall through to default verification
    }
    callback(-3);
  });

  app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
    const parsed = parseUrlHost(url);
    if (!parsed) {
      callback(false);
      return;
    }

    if (isLocalNetworkHost(parsed.hostname)) {
      addAllowedHost(parsed.hostname, parsed.port);
      event.preventDefault();
      console.log(`[Main] Auto-allowing certificate error for local host ${parsed.hostname}:${parsed.port ?? 'default'}`);
      callback(true);
      return;
    }

    const allowed = isHostAllowed(parsed.hostname, parsed.port);
    if (allowed) {
      event.preventDefault();
      console.log(`[Main] Allowing certificate via fallback for ${parsed.hostname}:${parsed.port ?? 'default'}`);
      callback(true);
      return;
    }

    console.warn(`[Main] Certificate rejected for ${parsed.hostname}:${parsed.port ?? 'default'}`);
    callback(false);
  });
}

ipcMain.handle('network:allow-insecure-cert', (_evt, urlString: unknown) => {
  if (typeof urlString !== 'string' || !urlString) {
    return { ok: false, error: 'Invalid URL' };
  }
  const parsed = parseUrlHost(urlString);
  if (!parsed) return { ok: true, skipped: true };
  addAllowedHost(parsed.hostname, parsed.port);
  if (isLocalNetworkHost(parsed.hostname)) {
    console.log(`[Main] Local network host ${parsed.hostname} will be trusted for all ports`);
  }
  console.log(`[Main] Added insecure certificate exception for ${parsed.hostname}:${parsed.port ?? 'any'}`);
  return { ok: true, host: `${parsed.hostname}:${parsed.port ?? 'any'}` };
});

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3000';

// Keep the renderer responsive when the window is minimized/occluded.
// These must be set before app is ready.
try {
  // Suppress noisy Chromium logging (e.g. cert_verify_proc_builtin.cc) that can appear even when
  // we intentionally allow self-signed certs for local-network hosts.
  app.commandLine.appendSwitch('disable-logging');
  app.commandLine.appendSwitch('log-level', '3');

  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  // Windows-only occlusion can still cause throttling; disable the feature.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
} catch {
  // ignore
}

let mainWindow: BrowserWindowType | null = null;
const driver = new SerialTCodeDriver();

let keepAwakeBlockId: number | null = null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function createWindow() {
  const preloadPath = path.join(__dirname, 'preload.js');
  console.log('[Main] Creating window with preload:', preloadPath);
  
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // Extra safety: ensure Electron doesn't throttle this window when minimized/occluded.
  try {
    mainWindow.webContents.setBackgroundThrottling(false);
  } catch {
    // ignore
  }

  const file = path.join(__dirname, 'renderer.html');
  console.log('[Main] Loading renderer:', file);
  await mainWindow.loadFile(file);
  console.log('[Main] Window loaded successfully');
}

ipcMain.handle('power:setKeepAwake', async (_evt, enabled: boolean) => {
  const on = Boolean(enabled);
  try {
    if (on) {
      if (keepAwakeBlockId == null || !powerSaveBlocker.isStarted(keepAwakeBlockId)) {
        // Prevent the app from being suspended while driving devices.
        keepAwakeBlockId = powerSaveBlocker.start('prevent-app-suspension');
      }
    } else {
      if (keepAwakeBlockId != null && powerSaveBlocker.isStarted(keepAwakeBlockId)) {
        powerSaveBlocker.stop(keepAwakeBlockId);
      }
      keepAwakeBlockId = null;
    }
  } catch {
    // ignore
  }
  return { ok: true, enabled: on };
});

ipcMain.handle('serial:listPorts', async () => {
  try {
    const ports = await SerialPort.list();
    return ports.map((p) => ({ path: p.path }));
  } catch (err) {
    console.error('Failed to list serial ports:', err);
    return [];
  }
});

ipcMain.handle('serial:connect', async (_evt, opts: { path: string; baudRate: number }) => {
  await driver.connect({ path: opts.path, baudRate: opts.baudRate });
});

ipcMain.handle('serial:disconnect', async () => {
  await driver.disconnect();
});

ipcMain.handle('serial:send', async (_evt, line: string) => {
  driver.sendLine(line);
});

app.whenReady().then(async () => {
  setupCertificateHandling();
  await createWindow();
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
