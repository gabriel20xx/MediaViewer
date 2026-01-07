import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserWindow as BrowserWindowType } from 'electron';
import * as electron from 'electron';
import { SerialPort } from 'serialport';
import { SerialTCodeDriver } from './serialDriver.js';

const { app, BrowserWindow, ipcMain, powerSaveBlocker } = electron;

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3000';

// Keep the renderer responsive when the window is minimized/occluded.
// These must be set before app is ready.
try {
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
  await createWindow();
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
