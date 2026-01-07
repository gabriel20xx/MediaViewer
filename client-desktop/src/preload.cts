// @ts-ignore: Using require in a module context for Electron preload
const { contextBridge, ipcRenderer } = require('electron');

console.log('[Preload] Preload script starting...');

try {
  contextBridge.exposeInMainWorld('mv', {
    listSerialPorts: () => ipcRenderer.invoke('serial:listPorts'),
    serialConnect: (opts: { path: string; baudRate: number }) => ipcRenderer.invoke('serial:connect', opts),
    serialDisconnect: () => ipcRenderer.invoke('serial:disconnect'),
    tcodeSend: (line: string) => ipcRenderer.invoke('serial:send', line),
  });
  console.log('[Preload] Successfully exposed window.mv API');
} catch (err) {
  console.error('[Preload] Failed to expose API:', err);
}
