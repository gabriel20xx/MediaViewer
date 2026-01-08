import { newId } from './ids.js';

export type SyncPlaybackState = {
  sessionId: string;
  mediaId: string | null;
  timeMs: number;
  paused: boolean;
  fps: number;
  frame: number;
  fromClientId: string;
  updatedAt: string;
};

export type PlaybackState = {
  id: string;
  clientId: string;
  mediaId: string;
  timeMs: number;
  fps: number;
  frame: number;
  updatedAt: string;
};

const syncStateBySession = new Map<string, SyncPlaybackState>();
const playbackStateByKey = new Map<string, PlaybackState>();

function nowIso(): string {
  return new Date().toISOString();
}

export function getSyncPlaybackState(sessionId: string): SyncPlaybackState {
  const id = String(sessionId ?? 'default').trim() || 'default';
  const existing = syncStateBySession.get(id);
  if (existing) return existing;
  return {
    sessionId: id,
    mediaId: null,
    timeMs: 0,
    paused: true,
    fps: 30,
    frame: 0,
    fromClientId: '',
    updatedAt: new Date(0).toISOString(),
  };
}

export function upsertSyncPlaybackState(input: {
  sessionId: string;
  mediaId: string | null;
  timeMs: number;
  paused: boolean;
  fps: number;
  frame: number;
  fromClientId: string;
}): SyncPlaybackState {
  const sessionId = String(input.sessionId ?? 'default').trim() || 'default';

  const next: SyncPlaybackState = {
    sessionId,
    mediaId: input.mediaId === null ? null : String(input.mediaId ?? '').trim(),
    timeMs: Math.max(0, Math.round(Number(input.timeMs) || 0)),
    paused: Boolean(input.paused),
    fps: Math.max(1, Math.round(Number(input.fps) || 30)),
    frame: Math.max(0, Math.round(Number(input.frame) || 0)),
    fromClientId: String(input.fromClientId ?? ''),
    updatedAt: nowIso(),
  };

  syncStateBySession.set(sessionId, next);
  return next;
}

function playbackKey(clientId: string, mediaId: string): string {
  return `${clientId}\u0000${mediaId}`;
}

export function getPlaybackState(input: { clientId: string; mediaId: string }): PlaybackState | null {
  const clientId = String(input.clientId ?? '').trim();
  const mediaId = String(input.mediaId ?? '').trim();
  if (!clientId || !mediaId) return null;
  return playbackStateByKey.get(playbackKey(clientId, mediaId)) ?? null;
}

export function upsertPlaybackState(input: {
  clientId: string;
  mediaId: string;
  timeMs: number;
  fps: number;
  frame: number;
}): PlaybackState {
  const clientId = String(input.clientId ?? '').trim();
  const mediaId = String(input.mediaId ?? '').trim();

  const timeMs = Math.max(0, Math.round(Number(input.timeMs) || 0));
  const fps = Math.max(1, Math.round(Number(input.fps) || 30));
  const frame = Math.max(0, Math.round(Number(input.frame) || 0));

  const key = playbackKey(clientId, mediaId);
  const prev = playbackStateByKey.get(key);

  const next: PlaybackState = {
    id: prev?.id || newId(),
    clientId,
    mediaId,
    timeMs,
    fps,
    frame,
    updatedAt: nowIso(),
  };

  playbackStateByKey.set(key, next);
  return next;
}
