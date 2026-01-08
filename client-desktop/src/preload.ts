import { contextBridge, ipcRenderer } from 'electron';
import * as net from 'node:net';

console.log('[Preload] Preload script starting...');

type DeoVrRemoteApiData = {
  path?: string;
  duration?: number;
  currentTime?: number;
  playbackSpeed?: number;
  playerState?: number; // Play = 0, Pause = 1
};

function createDeoVrRemoteControl() {
  /** @type {import('net').Socket | null} */
  let socket: any = null;
  let host: string | null = null;
  let buffer: Buffer = Buffer.alloc(0);
  let pingTimer: any = null;
  /** @type {Set<(s: any) => void>} */
  const statusHandlers = new Set<(s: DeoVrRemoteApiData) => void>();
  /** @type {Set<(e: any) => void>} */
  const connHandlers = new Set<(e: { type: 'connected' | 'disconnected' | 'error'; host?: string; error?: string }) => void>();

  function emitConn(evt: { type: 'connected' | 'disconnected' | 'error'; host?: string; error?: string }) {
    for (const fn of Array.from(connHandlers)) {
      try { fn(evt); } catch {}
    }
  }

  function emitStatus(s: DeoVrRemoteApiData) {
    for (const fn of Array.from(statusHandlers)) {
      try { fn(s); } catch {}
    }
  }

  function cleanup() {
    try { if (pingTimer) clearInterval(pingTimer); } catch {}
    pingTimer = null;
    try { if (socket) socket.removeAllListeners(); } catch {}
    try { if (socket) socket.destroy(); } catch {}
    socket = null;
    buffer = Buffer.alloc(0);
  }

  function writePacket(json: any | null) {
    if (!socket) return;
    const payload = json ? Buffer.from(JSON.stringify(json), 'utf8') : Buffer.alloc(0);
    const header = Buffer.alloc(4);
    // DeoVR's sample client is C#; length is an Int32 (little-endian on Windows).
    header.writeInt32LE(payload.length, 0);
    try {
      socket.write(Buffer.concat([header, payload]));
    } catch {
      // ignore
    }
  }

  function onData(chunk: Buffer) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const len = buffer.readInt32LE(0);
      if (len < 0 || len > 10_000_000) {
        // invalid; drop connection
        emitConn({ type: 'error', host: host || undefined, error: 'Invalid packet length' });
        cleanup();
        return;
      }
      if (buffer.length < 4 + len) return;
      const jsonBytes = buffer.subarray(4, 4 + len);
      buffer = buffer.subarray(4 + len);
      if (len === 0) continue;
      try {
        const parsed = JSON.parse(jsonBytes.toString('utf8'));
        if (parsed && typeof parsed === 'object') emitStatus(parsed);
      } catch {
        // ignore parse errors
      }
    }
  }

  async function connect(nextHost: string, port = 23554): Promise<{ ok: boolean; host?: string; error?: string }> {
    const h = String(nextHost || '').trim();
    if (!h) return { ok: false, error: 'host required' };
    if (socket && host === h && !socket.destroyed) return { ok: true, host: h };

    // Hard reset any previous connection
    const prevHost = host;
    host = h;
    cleanup();

    return await new Promise((resolve) => {
      try {
        socket = net.createConnection({ host: h, port }, () => {
          emitConn({ type: 'connected', host: h });
          // Keepalive ping: DeoVR will close if it doesn't get packets for >3 seconds.
          pingTimer = setInterval(() => writePacket(null), 1000);
          // Send an immediate first ping.
          writePacket(null);
          resolve({ ok: true, host: h });
        });
        socket.on('data', onData);
        socket.on('close', () => {
          const cur = host;
          cleanup();
          emitConn({ type: 'disconnected', host: cur || prevHost || undefined });
        });
        socket.on('error', (err: any) => {
          const msg = err && err.message ? String(err.message) : 'Socket error';
          emitConn({ type: 'error', host: h, error: msg });
          try { resolve({ ok: false, host: h, error: msg }); } catch {}
          cleanup();
        });
      } catch (err: any) {
        const msg = err && err.message ? String(err.message) : 'Connect failed';
        emitConn({ type: 'error', host: h, error: msg });
        cleanup();
        resolve({ ok: false, host: h, error: msg });
      }
    });
  }

  function disconnect() {
    const cur = host;
    cleanup();
    emitConn({ type: 'disconnected', host: cur || undefined });
  }

  function send(json: DeoVrRemoteApiData) {
    // If caller passes {}, treat as ping.
    if (!json || (typeof json === 'object' && Object.keys(json).length === 0)) {
      writePacket(null);
      return;
    }
    writePacket(json);
  }

  function onStatus(handler: (s: DeoVrRemoteApiData) => void) {
    if (typeof handler !== 'function') return () => {};
    statusHandlers.add(handler);
    return () => statusHandlers.delete(handler);
  }

  function onConnection(handler: (e: { type: 'connected' | 'disconnected' | 'error'; host?: string; error?: string }) => void) {
    if (typeof handler !== 'function') return () => {};
    connHandlers.add(handler);
    return () => connHandlers.delete(handler);
  }

  function getConnectionInfo() {
    return {
      ok: Boolean(socket && !socket.destroyed),
      host: host || undefined,
    };
  }

  return { connect, disconnect, send, onStatus, onConnection, getConnectionInfo };
}

const deoVrRemote = createDeoVrRemoteControl();

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
    deoVrSend: (data: any) => deoVrRemote.send(data || null),
    deoVrGetConnectionInfo: () => deoVrRemote.getConnectionInfo(),
    deoVrOnStatus: (handler: any) => deoVrRemote.onStatus(handler),
    deoVrOnConnection: (handler: any) => deoVrRemote.onConnection(handler),
  });
  console.log('[Preload] Successfully exposed window.mv API');
} catch (err) {
  console.error('[Preload] Failed to expose API:', err);
}
