import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import mime from 'mime-types';
import { PrismaClient } from '@prisma/client';
import { upsertMediaFromDisk } from './mediaScanner.js';
import { loadFunscriptIfExists } from './funscript.js';

export function buildApiRouter(opts: {
  prisma: PrismaClient;
  mediaRoot: string;
}) {
  const { prisma, mediaRoot } = opts;
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  router.post('/scan', async (_req, res) => {
    const result = await upsertMediaFromDisk({ prisma, mediaRoot });
    res.json(result);
  });

  router.get('/media', async (req, res) => {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const page = Math.max(1, Number(req.query.page ?? 1) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 48) || 48));

    const where = q
      ? { filename: { contains: q, mode: 'insensitive' as const } }
      : {};

    const [total, items] = await Promise.all([
      prisma.mediaItem.count({ where }),
      prisma.mediaItem.findMany({
        where,
        orderBy: [{ modifiedMs: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    res.json({
      total,
      page,
      pageSize,
      items: items.map((m) => ({
        id: m.id,
        filename: m.filename,
        relPath: m.relPath,
        mediaType: m.mediaType,
        hasFunscript: m.hasFunscript,
        sizeBytes: m.sizeBytes.toString(),
        modifiedMs: m.modifiedMs.toString(),
      })),
    });
  });

  router.get('/media/:id/stream', async (req, res) => {
    const id = req.params.id;
    const item = await prisma.mediaItem.findUnique({ where: { id } });
    if (!item) return res.status(404).json({ error: 'Not found' });

    const abs = path.join(mediaRoot, item.relPath);
    const contentType = mime.lookup(abs) || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);

    // Use express's built-in static sender by delegating to res.sendFile (supports range).
    return res.sendFile(abs);
  });

  router.get('/media/:id/funscript', async (req, res) => {
    const id = req.params.id;
    const item = await prisma.mediaItem.findUnique({ where: { id } });
    if (!item) return res.status(404).json({ error: 'Not found' });

    const abs = path.join(mediaRoot, item.relPath);
    const fun = await loadFunscriptIfExists(abs);
    if (!fun) return res.status(404).json({ error: 'No funscript' });
    res.json(fun);
  });

  router.put('/playback', express.json(), async (req, res) => {
    const body = req.body as {
      clientId?: string;
      mediaId?: string;
      timeMs?: number;
      fps?: number;
      frame?: number;
    };

    if (!body.clientId || !body.mediaId) return res.status(400).json({ error: 'clientId and mediaId required' });
    if (typeof body.timeMs !== 'number' || typeof body.frame !== 'number') {
      return res.status(400).json({ error: 'timeMs and frame required' });
    }

    const fps = typeof body.fps === 'number' && Number.isFinite(body.fps) ? Math.max(1, Math.round(body.fps)) : 30;

    const saved = await prisma.playbackState.upsert({
      where: { clientId_mediaId: { clientId: body.clientId, mediaId: body.mediaId } },
      create: {
        clientId: body.clientId,
        mediaId: body.mediaId,
        timeMs: Math.max(0, Math.round(body.timeMs)),
        fps,
        frame: Math.max(0, Math.round(body.frame)),
      },
      update: {
        timeMs: Math.max(0, Math.round(body.timeMs)),
        fps,
        frame: Math.max(0, Math.round(body.frame)),
      },
    });

    res.json({
      id: saved.id,
      clientId: saved.clientId,
      mediaId: saved.mediaId,
      timeMs: saved.timeMs,
      fps: saved.fps,
      frame: saved.frame,
      updatedAt: saved.updatedAt,
    });
  });

  router.get('/playback', async (req, res) => {
    const clientId = String(req.query.clientId ?? '').trim();
    const mediaId = String(req.query.mediaId ?? '').trim();
    if (!clientId || !mediaId) return res.status(400).json({ error: 'clientId and mediaId required' });

    const row = await prisma.playbackState.findUnique({
      where: { clientId_mediaId: { clientId, mediaId } },
    });

    if (!row) return res.status(404).json({ error: 'Not found' });

    res.json({
      id: row.id,
      clientId: row.clientId,
      mediaId: row.mediaId,
      timeMs: row.timeMs,
      fps: row.fps,
      frame: row.frame,
      updatedAt: row.updatedAt,
    });
  });

  router.get('/media/:id/fileinfo', async (req, res) => {
    const id = req.params.id;
    const item = await prisma.mediaItem.findUnique({ where: { id } });
    if (!item) return res.status(404).json({ error: 'Not found' });

    const abs = path.join(mediaRoot, item.relPath);
    try {
      const stat = await fs.stat(abs);
      res.json({
        id: item.id,
        filename: item.filename,
        relPath: item.relPath,
        sizeBytes: stat.size,
        modifiedMs: stat.mtimeMs,
      });
    } catch {
      res.status(404).json({ error: 'Missing on disk' });
    }
  });

  return router;
}
