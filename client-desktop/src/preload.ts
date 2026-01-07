import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('mv', {
  listSerialPorts: () => ipcRenderer.invoke('serial:listPorts'),
  serialConnect: (opts: { path: string; baudRate: number }) => ipcRenderer.invoke('serial:connect', opts),
  serialDisconnect: () => ipcRenderer.invoke('serial:disconnect'),
  tcodeSend: (line: string) => ipcRenderer.invoke('serial:send', line),
});

declare global {
  interface Window {
    mv: {
      listSerialPorts(): Promise<Array<{ path: string }>>;
      serialConnect(opts: { path: string; baudRate: number }): Promise<void>;
      serialDisconnect(): Promise<void>;
      tcodeSend(line: string): Promise<void>;
    };
  }
}
