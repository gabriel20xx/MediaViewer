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
import { registerVrIntegrations } from './vrIntegrations.js';

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

// Store client metadata (clientId -> { userAgent, ipAddress })
const clientMetadata = new Map<string, { userAgent: string; ipAddress: string }>();
type WsClient = {
  send(data: string): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'close', cb: () => void): void;
  readyState: number;
  __mvClientId?: string;
  __mvSessionId?: string;
  __mvUserAgent?: string;
  __mvIpAddress?: string;
};

function safeJsonParse(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function redactDatabaseUrl(databaseUrl: string): string {
  try {
    const u = new URL(databaseUrl);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    // Fallback: basic redaction for non-URL formats.
    return databaseUrl.replace(/:\/\/(.*?):(.*?)@/g, '://$1:***@');
  }
}

function logStartupInfo() {
  const serverUrl = `http://localhost:${env.PORT}`;
  const ffprobePath = (process.env.FFPROBE_PATH || 'ffprobe').trim() || 'ffprobe';

  // eslint-disable-next-line no-console
  console.log('[MediaViewer] Starting...');
  // eslint-disable-next-line no-console
  console.log(`[MediaViewer] Node ${process.version} | ${process.platform} ${process.arch} | pid ${process.pid}`);
  // eslint-disable-next-line no-console
  console.log(`[MediaViewer] HTTP: ${serverUrl}/  (port ${env.PORT})`);
  // eslint-disable-next-line no-console
  console.log(`[MediaViewer] WebSocket: ${serverUrl}/ws`);
  // eslint-disable-next-line no-console
  console.log(`[MediaViewer] Media root: ${env.MEDIA_ROOT}`);
  // eslint-disable-next-line no-console
  console.log(`[MediaViewer] Public dir: ${publicDir}`);
  // eslint-disable-next-line no-console
  console.log(`[MediaViewer] DB: ${redactDatabaseUrl(env.DATABASE_URL)}`);
  // eslint-disable-next-line no-console
  console.log(`[MediaViewer] ffprobe: ${ffprobePath}`);
  // eslint-disable-next-line no-console
  console.log(`[MediaViewer] VR endpoints: ${serverUrl}/deovr  |  ${serverUrl}/heresphere`);
  if (env.CORS_ORIGIN) {
    // eslint-disable-next-line no-console
    console.log(`[MediaViewer] CORS origin: ${env.CORS_ORIGIN}`);
  }
}

async function broadcastSyncState(sessionId: string) {
  const state = await getSyncPlaybackState(db, sessionId);
  // Include all client metadata
  const clients = Array.from(clientMetadata.entries()).map(([id, meta]) => ({
    clientId: id,
    userAgent: meta.userAgent,
    ipAddress: meta.ipAddress,
  }));
  const msg = JSON.stringify({ type: 'sync:state', state, clients });
  for (const c of wss.clients) {
    const client = c as unknown as WsClient;
    // 1 is OPEN in ws lib
    if (client.readyState === 1) client.send(msg);
  }
}

async function publishExternalSyncUpdate(update: {
  sessionId: string;
  mediaId: string;
  fromClientId: string;
  timeMs: number;
  paused: boolean;
  fps: number;
  frame: number;
}) {
  await upsertSyncPlaybackState(db, {
    sessionId: update.sessionId,
    mediaId: update.mediaId,
    timeMs: update.timeMs,
    paused: update.paused,
    fps: update.fps,
    frame: update.frame,
    fromClientId: update.fromClientId,
  });

  // eslint-disable-next-line no-console
  console.log(`[MediaViewer] External sync: session=${update.sessionId} media=${update.mediaId} from=${update.fromClientId} paused=${update.paused} t=${update.timeMs}ms`);

  await broadcastSyncState(update.sessionId);
}

// VR player integrations (root endpoints expected by apps)
registerVrIntegrations(app, db, {
  onVrSync: async (info) => publishExternalSyncUpdate(info),
  ctx: { mediaRoot: env.MEDIA_ROOT },
});

wss.on('connection', (raw, req) => {
  const ws = raw as unknown as WsClient;
  
  // Capture user agent and IP address
  const userAgent = req.headers['user-agent'] || 'Unknown';
  const ipAddress = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() 
    || req.socket.remoteAddress 
    || 'Unknown';
  
  ws.__mvUserAgent = userAgent;
  ws.__mvIpAddress = ipAddress;
  
  ws.send(JSON.stringify({ type: 'hello', ts: Date.now() }));

  ws.on('close', () => {
    if (ws.__mvClientId) {
      clientMetadata.delete(ws.__mvClientId);
      if (ws.__mvSessionId) {
        broadcastSyncState(ws.__mvSessionId).catch(console.error);
      }
    }
  });

  ws.on('message', async (data) => {
    const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : '';
    const msg = safeJsonParse(text);
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'sync:hello') {
      const clientId = String(msg.clientId ?? '').trim();
      const sessionId = String(msg.sessionId ?? 'default').trim() || 'default';
      if (clientId) {
        ws.__mvClientId = clientId;
        // Store metadata for this client
        clientMetadata.set(clientId, {
          userAgent: ws.__mvUserAgent || 'Unknown',
          ipAddress: ws.__mvIpAddress || 'Unknown',
        });
      }
      ws.__mvSessionId = sessionId;

      // Broadcast latest state (including the new client list) to everyone
      broadcastSyncState(sessionId).catch(console.error);
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
  logStartupInfo();

  await ensureSchema(db);

  // Start server immediately
  server.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[MediaViewer] Server listening on :${env.PORT}`);
    // eslint-disable-next-line no-console
    console.log(`[MediaViewer] Web UI accessible at http://localhost:${env.PORT}/`);
    // eslint-disable-next-line no-console
    console.log(`[MediaViewer] Starting initial media scan in background...`);
  });

  // Initial scan in background (non-blocking).
  const scanStart = Date.now();
  upsertMediaFromDisk({ db, mediaRoot: env.MEDIA_ROOT })
    .then((scan) => {
      const scanMs = Date.now() - scanStart;
      // eslint-disable-next-line no-console
      console.log(`[MediaViewer] Initial scan complete: scanned=${scan.scanned}, upserted=${scan.upserted} (${scanMs}ms)`);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[MediaViewer] Initial scan failed:', err);
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
