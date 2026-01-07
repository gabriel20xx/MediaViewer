import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserWindow as BrowserWindowType } from 'electron';
import * as electron from 'electron';
import { SerialPort } from 'serialport';
import { SerialTCodeDriver } from './serialDriver.js';

const { app, BrowserWindow, ipcMain } = electron;

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3000';

let mainWindow: BrowserWindowType | null = null;
const driver = new SerialTCodeDriver();

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

  const file = path.join(__dirname, 'renderer.html');
  console.log('[Main] Loading renderer:', file);
  await mainWindow.loadFile(file);
  console.log('[Main] Window loaded successfully');
}

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
