// @ts-ignore: Using require in a module context for Electron preload
const { contextBridge, ipcRenderer } = require('electron');

console.log('[Preload] Preload script starting...');

type DeoVrConnEvent = { type: 'connected' | 'disconnected' | 'error'; host?: string; error?: string };

function createDeoVrRemoteControlIpc() {
  const statusHandlers = new Set<(s: any) => void>();
  const connHandlers = new Set<(e: DeoVrConnEvent) => void>();

  function emitConn(evt: DeoVrConnEvent) {
    for (const fn of Array.from(connHandlers)) {
      try { fn(evt); } catch {}
    }
  }

  function emitStatus(s: any) {
    for (const fn of Array.from(statusHandlers)) {
      try { fn(s); } catch {}
    }
  }

  try {
    ipcRenderer.on('deovr:status', (_evt: unknown, status: any) => emitStatus(status));
    ipcRenderer.on('deovr:connection', (_evt: unknown, evt: DeoVrConnEvent) => emitConn(evt));
  } catch {
    // ignore
  }

  function onStatus(handler: (s: any) => void) {
    if (typeof handler !== 'function') return () => {};
    statusHandlers.add(handler);
    return () => statusHandlers.delete(handler);
  }

  function onConnection(handler: (e: DeoVrConnEvent) => void) {
    if (typeof handler !== 'function') return () => {};
    connHandlers.add(handler);
    return () => connHandlers.delete(handler);
  }

  return {
    connect: (host: string, port = 23554) => ipcRenderer.invoke('deovr:connect', host, port),
    disconnect: () => ipcRenderer.invoke('deovr:disconnect'),
    send: (data: any) => ipcRenderer.invoke('deovr:send', data ?? null),
    getConnectionInfo: () => ipcRenderer.invoke('deovr:getConnectionInfo'),
    onStatus,
    onConnection,
  };
}

const deoVrRemote = createDeoVrRemoteControlIpc();

try {
  contextBridge.exposeInMainWorld('mv', {
    listSerialPorts: () => ipcRenderer.invoke('serial:listPorts'),
    serialConnect: (opts: { path: string; baudRate: number }) => ipcRenderer.invoke('serial:connect', opts),
    serialDisconnect: () => ipcRenderer.invoke('serial:disconnect'),
    tcodeSend: (line: string) => ipcRenderer.invoke('serial:send', line),
    setKeepAwake: (enabled: boolean) => ipcRenderer.invoke('power:setKeepAwake', Boolean(enabled)),
    allowInsecureCertForUrl: (url: string) => ipcRenderer.invoke('network:allow-insecure-cert', url),

    // DeoVR Remote Control (TCP 23554)
    deoVrConnect: (host: string) => deoVrRemote.connect(host, 23554),
    deoVrDisconnect: () => deoVrRemote.disconnect(),
    deoVrSend: (data: any) => deoVrRemote.send(data),
    deoVrGetConnectionInfo: () => deoVrRemote.getConnectionInfo(),
    deoVrOnStatus: (handler: any) => deoVrRemote.onStatus(handler),
    deoVrOnConnection: (handler: any) => deoVrRemote.onConnection(handler),
  });
  console.log('[Preload] Successfully exposed window.mv API');
} catch (err) {
  console.error('[Preload] Failed to expose API:', err);
}
