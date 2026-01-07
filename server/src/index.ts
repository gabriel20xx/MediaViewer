import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { PrismaClient } from '@prisma/client';
import { readEnv } from './env.js';
import { buildApiRouter } from './api.js';
import { upsertMediaFromDisk } from './mediaScanner.js';

const env = readEnv();
const prisma = new PrismaClient();

const app = express();

if (env.CORS_ORIGIN) {
  app.use(cors({ origin: env.CORS_ORIGIN }));
}

app.use('/api', buildApiRouter({ prisma, mediaRoot: env.MEDIA_ROOT }));

// Serve Web UI (static files built into /public)
const publicDir = path.join(process.cwd(), 'public');
app.use(express.static(publicDir));
app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const server = http.createServer(app);

// Minimal websocket for live playback pings (optional consumer).
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', ts: Date.now() }));
});

async function main() {
  await prisma.$connect();

  // Initial scan on boot.
  await upsertMediaFromDisk({ prisma, mediaRoot: env.MEDIA_ROOT });

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
