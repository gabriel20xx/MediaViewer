import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { readEnv } from './env.js';
import { buildApiRouter } from './api.js';
import { upsertMediaFromDisk } from './mediaScanner.js';
import { createDb, ensureSchema } from './db.js';
import { getSyncPlaybackState, upsertSyncPlaybackState } from './syncState.js';

const env = readEnv();
const db = createDb(env.DATABASE_URL);

const app = express();

if (env.CORS_ORIGIN) {
  app.use(cors({ origin: env.CORS_ORIGIN }));
}

app.use('/api', buildApiRouter({ db, mediaRoot: env.MEDIA_ROOT }));

// Serve Web UI (static files built into /public)
const publicDir = path.join(process.cwd(), 'public');
app.use(express.static(publicDir));
app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const server = http.createServer(app);

// Minimal websocket for live playback pings (optional consumer).
const wss = new WebSocketServer({ server, path: '/ws' });
type WsClient = {
  send(data: string): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'close', cb: () => void): void;
  readyState: number;
  __mvClientId?: string;
  __mvSessionId?: string;
};

function safeJsonParse(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function broadcastSyncState(sessionId: string) {
  const state = await getSyncPlaybackState(db, sessionId);
  const msg = JSON.stringify({ type: 'sync:state', state });
  for (const c of wss.clients) {
    const client = c as unknown as WsClient;
    // 1 is OPEN in ws lib
    if (client.readyState === 1) client.send(msg);
  }
}

wss.on('connection', (raw) => {
  const ws = raw as unknown as WsClient;
  ws.send(JSON.stringify({ type: 'hello', ts: Date.now() }));

  ws.on('message', async (data) => {
    const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : '';
    const msg = safeJsonParse(text);
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'sync:hello') {
      const clientId = String(msg.clientId ?? '').trim();
      const sessionId = String(msg.sessionId ?? 'default').trim() || 'default';
      if (clientId) ws.__mvClientId = clientId;
      ws.__mvSessionId = sessionId;

      const state = await getSyncPlaybackState(db, sessionId);
      ws.send(JSON.stringify({ type: 'sync:state', state }));
      return;
    }

    if (msg.type === 'sync:update') {
      const clientId = String(msg.clientId ?? ws.__mvClientId ?? '').trim();
      const sessionId = String(msg.sessionId ?? ws.__mvSessionId ?? 'default').trim() || 'default';
      const mediaId = msg.mediaId === null ? null : String(msg.mediaId ?? '').trim();
      if (!clientId || mediaId === '') return;

      const timeMs = typeof msg.timeMs === 'number' ? msg.timeMs : 0;
      const paused = Boolean(msg.paused);
      const fps = typeof msg.fps === 'number' && Number.isFinite(msg.fps) ? msg.fps : 30;
      const frame = typeof msg.frame === 'number' && Number.isFinite(msg.frame) ? msg.frame : 0;

      await upsertSyncPlaybackState(db, {
        sessionId,
        mediaId,
        timeMs,
        paused,
        fps,
        frame,
        fromClientId: clientId,
      });

      await broadcastSyncState(sessionId);
      return;
    }
  });
});

async function main() {
  await ensureSchema(db);

  // Initial scan on boot.
  await upsertMediaFromDisk({ db, mediaRoot: env.MEDIA_ROOT });

  server.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`MediaViewer server listening on :${env.PORT}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  await db.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await db.close();
  process.exit(0);
});
