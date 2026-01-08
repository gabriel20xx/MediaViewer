import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import type { BrowserWindow as BrowserWindowType } from 'electron';
import * as electron from 'electron';
import { SerialPort } from 'serialport';
import { isIP, createConnection, type Socket } from 'node:net';
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

type DeoVrConnEvent = { type: 'connected' | 'disconnected' | 'error'; host?: string; error?: string };

let deoVrSocket: Socket | null = null;
let deoVrHost: string | null = null;
let deoVrBuffer: Buffer = Buffer.alloc(0);
let deoVrPingTimer: NodeJS.Timeout | null = null;

function deoVrEmitConnection(evt: DeoVrConnEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send('deovr:connection', evt);
    } catch {
      // ignore
    }
  }
}

function deoVrEmitStatus(status: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send('deovr:status', status);
    } catch {
      // ignore
    }
  }
}

function deoVrCleanup(): void {
  try {
    if (deoVrPingTimer) clearInterval(deoVrPingTimer);
  } catch {
    // ignore
  }
  deoVrPingTimer = null;

  try {
    if (deoVrSocket) deoVrSocket.removeAllListeners();
  } catch {
    // ignore
  }
  try {
    if (deoVrSocket) deoVrSocket.destroy();
  } catch {
    // ignore
  }
  deoVrSocket = null;
  deoVrBuffer = Buffer.alloc(0);
}

function deoVrWritePacket(json: any | null): void {
  if (!deoVrSocket) return;
  const payload = json ? Buffer.from(JSON.stringify(json), 'utf8') : Buffer.alloc(0);
  const header = Buffer.alloc(4);
  header.writeInt32LE(payload.length, 0);
  try {
    deoVrSocket.write(Buffer.concat([header, payload]));
  } catch {
    // ignore
  }
}

function deoVrOnData(chunk: Buffer): void {
  deoVrBuffer = Buffer.concat([deoVrBuffer, chunk]);
  while (deoVrBuffer.length >= 4) {
    const len = deoVrBuffer.readInt32LE(0);
    if (len < 0 || len > 10_000_000) {
      deoVrEmitConnection({ type: 'error', host: deoVrHost || undefined, error: 'Invalid packet length' });
      deoVrCleanup();
      return;
    }
    if (deoVrBuffer.length < 4 + len) return;
    const jsonBytes = deoVrBuffer.subarray(4, 4 + len);
    deoVrBuffer = deoVrBuffer.subarray(4 + len);
    if (len === 0) continue;
    try {
      const parsed = JSON.parse(jsonBytes.toString('utf8'));
      if (parsed && typeof parsed === 'object') deoVrEmitStatus(parsed);
    } catch {
      // ignore
    }
  }
}

let keepAwakeBlockId: number | null = null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function createWindow() {
  const preloadCjs = path.join(__dirname, 'preload.cjs');
  const preloadJs = path.join(__dirname, 'preload.js');
  const preloadPath = fs.existsSync(preloadCjs) ? preloadCjs : preloadJs;
  console.log('[Main] Creating window with preload:', preloadPath);
  if (!fs.existsSync(preloadPath)) {
    console.error('[Main] Preload script not found at:', preloadPath);
  }
  
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    try {
      mainWindow?.show();
      mainWindow?.focus();
    } catch {
      // ignore
    }
  });

  // Forward renderer/preload console output into the main process logs.
  try {
    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      console.log(`[Renderer][${level}] ${message} (${sourceId}:${line})`);
    });
  } catch {
    // ignore
  }

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

  // Sanity-check that preload executed and injected the API.
  try {
    const mvType = await mainWindow.webContents.executeJavaScript('typeof window.mv', true);
    console.log(`[Main] typeof window.mv = ${String(mvType)}`);
  } catch (err) {
    const msg = (err as any)?.message ? String((err as any).message) : String(err);
    console.warn('[Main] Unable to query window.mv:', msg);
  }

  // Helpful diagnostics when preload fails to execute.
  try {
    (mainWindow.webContents as any).on('preload-error', (...args: any[]) => {
      console.error('[Main] preload-error:', ...args);
    });
  } catch {
    // ignore
  }
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

ipcMain.handle('deovr:connect', async (_evt, host: unknown, port: unknown) => {
  const h = String(host ?? '').trim();
  const p = Number(port ?? 23554);
  if (!h) return { ok: false, error: 'host required' };
  if (!Number.isFinite(p) || p <= 0) return { ok: false, error: 'invalid port' };

  if (deoVrSocket && deoVrHost === h && !deoVrSocket.destroyed) return { ok: true, host: h };

  const prevHost = deoVrHost;
  deoVrHost = h;
  deoVrCleanup();

  return await new Promise<{ ok: boolean; host?: string; error?: string }>((resolve) => {
    let resolved = false;
    try {
      const s = createConnection({ host: h, port: p }, () => {
        deoVrSocket = s;
        deoVrEmitConnection({ type: 'connected', host: h });
        deoVrPingTimer = setInterval(() => deoVrWritePacket(null), 1000);
        deoVrWritePacket(null);
        if (!resolved) {
          resolved = true;
          resolve({ ok: true, host: h });
        }
      });
      deoVrSocket = s;
      s.on('data', deoVrOnData);
      s.on('close', () => {
        const cur = deoVrHost;
        deoVrCleanup();
        deoVrEmitConnection({ type: 'disconnected', host: cur || prevHost || undefined });
      });
      s.on('error', (err: any) => {
        const msg = err && err.message ? String(err.message) : 'Socket error';
        deoVrEmitConnection({ type: 'error', host: h, error: msg });
        if (!resolved) {
          resolved = true;
          resolve({ ok: false, host: h, error: msg });
        }
        deoVrCleanup();
      });
    } catch (err: any) {
      const msg = err && err.message ? String(err.message) : 'Connect failed';
      deoVrEmitConnection({ type: 'error', host: h, error: msg });
      deoVrCleanup();
      if (!resolved) {
        resolved = true;
        resolve({ ok: false, host: h, error: msg });
      }
    }
  });
});

ipcMain.handle('deovr:disconnect', async () => {
  const cur = deoVrHost;
  deoVrCleanup();
  deoVrEmitConnection({ type: 'disconnected', host: cur || undefined });
  return { ok: true };
});

ipcMain.handle('deovr:send', async (_evt, data: unknown) => {
  const payload = data && typeof data === 'object' ? (data as any) : null;
  if (payload && typeof payload === 'object' && Object.keys(payload).length === 0) {
    deoVrWritePacket(null);
    return { ok: true, ping: true };
  }
  deoVrWritePacket(payload);
  return { ok: true };
});

ipcMain.handle('deovr:getConnectionInfo', async () => {
  return {
    ok: Boolean(deoVrSocket && !deoVrSocket.destroyed),
    host: deoVrHost || undefined,
  };
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
