import 'dotenv/config';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import selfsigned from 'selfsigned';
import { readEnv } from './env.js';
import { buildApiRouter } from './api.js';
import { upsertMediaFromDisk } from './mediaScanner.js';
import { createDb, ensureSchema } from './db.js';
import { getSyncPlaybackState, upsertSyncPlaybackState } from './syncState.js';
import { registerVrIntegrations } from './vrIntegrations.js';

const env = readEnv();
const db = createDb(env.DATABASE_URL);

const app = express();

// Many VR apps are used behind reverse proxies (https). Trust proxy headers so req.protocol is correct.
app.set('trust proxy', true);

if (env.CORS_ORIGIN) {
  app.use(cors({ origin: env.CORS_ORIGIN }));
}

app.use('/api', buildApiRouter({ db, mediaRoot: env.MEDIA_ROOT }));

// Serve Web UI (static files built into /public)
const publicDir = path.join(process.cwd(), 'public');
app.use(express.static(publicDir));
app.get('*', (req, res, next) => {
  // IMPORTANT: Keep VR integration endpoints reachable.
  // DeoVR/HereSphere fetch JSON from these paths; our SPA catch-all must not shadow them.
  const p = String(req.path || '');
  if (p === '/deovr' || p.startsWith('/deovr/')) return next();
  if (p === '/heresphere' || p.startsWith('/heresphere/')) return next();
  if (p === '/thumb' || p.startsWith('/thumb/')) return next();

  res.sendFile(path.join(publicDir, 'index.html'));
});

let isHttpsEnabled = false;
let activeServer: http.Server | https.Server;

// Minimal websocket for live playback pings (optional consumer).
let wss: WebSocketServer;

// Store client metadata (clientId -> { userAgent, ipAddress })
const clientMetadata = new Map<string, { userAgent: string; ipAddress: string }>();
// Store lightweight per-client UI status (clientId -> { uiView, mediaId })
const clientUiStatus = new Map<string, { uiView?: string; mediaId?: string | null }>();
// Ephemeral per-session scheduled play time (ISO string). Used to coordinate exact start.
const sessionPlayAt = new Map<string, string>();
const clientsById = new Map<string, Set<WsClient>>();
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
  const scheme = isHttpsEnabled ? 'https' : 'http';
  const serverUrl = `${scheme}://localhost:${env.PORT}`;
  const ffprobePath = (process.env.FFPROBE_PATH || 'ffprobe').trim() || 'ffprobe';

  // eslint-disable-next-line no-console
  console.log('[MediaViewer] Starting...');
  // eslint-disable-next-line no-console
  console.log(`[MediaViewer] Node ${process.version} | ${process.platform} ${process.arch} | pid ${process.pid}`);
  // eslint-disable-next-line no-console
  console.log(`[MediaViewer] ${scheme.toUpperCase()}: ${serverUrl}/  (port ${env.PORT})`);
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

function ensureSelfSignedHttpsCert(keyPath: string, certPath: string) {
  const hasKey = fs.existsSync(keyPath);
  const hasCert = fs.existsSync(certPath);
  if (hasKey && hasCert) return;

  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.mkdirSync(path.dirname(certPath), { recursive: true });

  const existingKey = hasKey ? fs.readFileSync(keyPath, 'utf8') : undefined;

  const attrs = [{ name: 'commonName', value: 'localhost' }];
  const opts: any = {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
        ],
      },
    ],
  };
  if (existingKey) opts.key = existingKey;
  const pems = selfsigned.generate(attrs, opts);

  if (!hasKey) fs.writeFileSync(keyPath, pems.private, 'utf8');
  if (!hasCert) fs.writeFileSync(certPath, pems.cert, 'utf8');
}

function buildClientsList() {
  return Array.from(clientMetadata.entries()).map(([id, meta]) => {
    const ui = clientUiStatus.get(id);
    return {
      clientId: id,
      userAgent: meta.userAgent,
      ipAddress: meta.ipAddress,
      uiView: ui?.uiView,
      uiMediaId: typeof ui?.mediaId === 'string' ? ui.mediaId : ui?.mediaId === null ? null : undefined,
    };
  });
}

async function broadcastSyncState(sessionId: string) {
  const baseState = await getSyncPlaybackState(db, sessionId);
  const playAt = sessionPlayAt.get(sessionId);
  const state = (!baseState.paused && playAt)
    ? ({ ...baseState, playAt } as any)
    : baseState;
  // Include all client metadata
  const clients = buildClientsList();
  const msg = JSON.stringify({ type: 'sync:state', state, clients });
  for (const c of wss.clients) {
    const client = c as unknown as WsClient;
    // 1 is OPEN in ws lib
    if (client.readyState === 1) client.send(msg);
  }
}

function sendSyncStateToClient(sessionId: string, toClientId: string, state: any) {
  const targets = clientsById.get(toClientId);
  if (!targets || targets.size === 0) return;
  const clients = buildClientsList();
  const playAt = sessionPlayAt.get(sessionId);
  const stateWithPlayAt = (state && state.paused === false && playAt)
    ? { sessionId, ...state, playAt }
    : { sessionId, ...state };
  const msg = JSON.stringify({ type: 'sync:state', state: stateWithPlayAt, clients });
  for (const ws of targets) {
    if (ws.readyState === 1) ws.send(msg);
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

function registerWsHandlers() {
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
      clientUiStatus.delete(ws.__mvClientId);
      const set = clientsById.get(ws.__mvClientId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) clientsById.delete(ws.__mvClientId);
      }
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
        // Re-key if needed.
        if (ws.__mvClientId && ws.__mvClientId !== clientId) {
          const prior = clientsById.get(ws.__mvClientId);
          if (prior) {
            prior.delete(ws);
            if (prior.size === 0) clientsById.delete(ws.__mvClientId);
          }
          clientMetadata.delete(ws.__mvClientId);
        }
        ws.__mvClientId = clientId;
        // Store metadata for this client
        clientMetadata.set(clientId, {
          userAgent: ws.__mvUserAgent || 'Unknown',
          ipAddress: ws.__mvIpAddress || 'Unknown',
        });

        let set = clientsById.get(clientId);
        if (!set) {
          set = new Set();
          clientsById.set(clientId, set);
        }
        set.add(ws);
      }
      ws.__mvSessionId = sessionId;

      // Broadcast latest state (including the new client list) to everyone
      broadcastSyncState(sessionId).catch(console.error);
      return;
    }

    if (msg.type === 'client:status') {
      const clientId = String(msg.clientId ?? ws.__mvClientId ?? '').trim();
      const sessionId = String(msg.sessionId ?? ws.__mvSessionId ?? 'default').trim() || 'default';
      if (!clientId) return;

      const uiView = typeof msg.uiView === 'string' ? String(msg.uiView).trim() : '';
      const uiMediaIdRaw = msg.mediaId;
      const uiMediaId = uiMediaIdRaw === null ? null : typeof uiMediaIdRaw === 'string' ? String(uiMediaIdRaw).trim() : undefined;

      const prev = clientUiStatus.get(clientId);
      const next = {
        uiView: uiView || prev?.uiView,
        mediaId: uiMediaId !== undefined ? uiMediaId : prev?.mediaId,
      };
      clientUiStatus.set(clientId, next);

      // Broadcast so other clients can make decisions based on UI state.
      broadcastSyncState(sessionId).catch(console.error);
      return;
    }

    if (msg.type === 'sync:update') {
      const clientId = String(msg.clientId ?? ws.__mvClientId ?? '').trim();
      const sessionId = String(msg.sessionId ?? ws.__mvSessionId ?? 'default').trim() || 'default';
      const mediaId = msg.mediaId === null ? null : String(msg.mediaId ?? '').trim();
      if (!clientId || mediaId === '') return;

      // Optional scheduled play time (ISO). Clients use this to start at the same moment.
      const playAtRaw = (msg as any).playAt;
      const playAt = playAtRaw === null ? null : (typeof playAtRaw === 'string' ? String(playAtRaw).trim() : '');
      if (playAt === null) {
        sessionPlayAt.delete(sessionId);
      } else if (playAt) {
        const t = Date.parse(playAt);
        if (!Number.isNaN(t)) sessionPlayAt.set(sessionId, new Date(t).toISOString());
      }

      const toClientId = typeof msg.toClientId === 'string' ? String(msg.toClientId).trim() : '';

      const timeMs = typeof msg.timeMs === 'number' ? msg.timeMs : 0;
      const paused = Boolean(msg.paused);
      const fps = typeof msg.fps === 'number' && Number.isFinite(msg.fps) ? msg.fps : 30;
      const frame = typeof msg.frame === 'number' && Number.isFinite(msg.frame) ? msg.frame : 0;

      // Targeted control: route directly to a single client without updating global session state.
      if (toClientId) {
        if (paused) sessionPlayAt.delete(sessionId);
        const scheduled = !paused ? sessionPlayAt.get(sessionId) : undefined;
        sendSyncStateToClient(sessionId, toClientId, {
          mediaId,
          timeMs,
          paused,
          fps,
          frame,
          fromClientId: clientId,
          ...(scheduled ? { playAt: scheduled } : {}),
          updatedAt: new Date().toISOString(),
        });
        return;
      }

      if (paused) sessionPlayAt.delete(sessionId);

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
}

async function main() {
  const autoSelfSigned = Boolean(env.HTTPS_AUTO_SELF_SIGNED);

  let keyPath = (env.HTTPS_KEY_PATH || '').trim();
  let certPath = (env.HTTPS_CERT_PATH || '').trim();
  if (autoSelfSigned) {
    const baseDir = path.join(process.cwd(), '.mv-https');
    if (!keyPath) keyPath = path.join(baseDir, 'localhost.key.pem');
    if (!certPath) certPath = path.join(baseDir, 'localhost.cert.pem');
    ensureSelfSignedHttpsCert(keyPath, certPath);
  }

  isHttpsEnabled = Boolean(keyPath && certPath);

  const server = http.createServer(app);
  activeServer = isHttpsEnabled
    ? https.createServer(
        {
          key: fs.readFileSync(keyPath),
          cert: fs.readFileSync(certPath),
        },
        app
      )
    : server;

  wss = new WebSocketServer({ server: activeServer, path: '/ws' });
  registerWsHandlers();

  logStartupInfo();

  await ensureSchema(db);

  // Start server immediately
  activeServer.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[MediaViewer] Server listening on :${env.PORT}`);
    // eslint-disable-next-line no-console
    console.log(`[MediaViewer] Web UI accessible at ${isHttpsEnabled ? 'https' : 'http'}://localhost:${env.PORT}/`);
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
