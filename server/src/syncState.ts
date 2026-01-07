import type { Db } from './db.js';

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

export async function getSyncPlaybackState(db: Db, sessionId: string): Promise<SyncPlaybackState> {
  const res = await db.pool.query(
    `SELECT session_id, media_id, time_ms, paused, fps, frame, from_client_id, updated_at
     FROM sync_playback_state
     WHERE session_id = $1
     LIMIT 1`,
    [sessionId]
  );

  const row = res.rows[0];
  if (!row) {
    return {
      sessionId,
      mediaId: null,
      timeMs: 0,
      paused: true,
      fps: 30,
      frame: 0,
      fromClientId: '',
      updatedAt: new Date(0).toISOString(),
    };
  }

  return {
    sessionId: row.session_id,
    mediaId: row.media_id ?? null,
    timeMs: Number(row.time_ms) || 0,
    paused: Boolean(row.paused),
    fps: Number(row.fps) || 30,
    frame: Number(row.frame) || 0,
    fromClientId: String(row.from_client_id ?? ''),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function upsertSyncPlaybackState(
  db: Db,
  input: {
    sessionId: string;
    mediaId: string | null;
    timeMs: number;
    paused: boolean;
    fps: number;
    frame: number;
    fromClientId: string;
  }
): Promise<SyncPlaybackState> {
  const res = await db.pool.query(
    `
      INSERT INTO sync_playback_state (session_id, media_id, time_ms, paused, fps, frame, from_client_id, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, now())
      ON CONFLICT (session_id)
      DO UPDATE SET
        media_id = EXCLUDED.media_id,
        time_ms = EXCLUDED.time_ms,
        paused = EXCLUDED.paused,
        fps = EXCLUDED.fps,
        frame = EXCLUDED.frame,
        from_client_id = EXCLUDED.from_client_id,
        updated_at = now()
      RETURNING session_id, media_id, time_ms, paused, fps, frame, from_client_id, updated_at
    `,
    [
      input.sessionId,
      input.mediaId,
      Math.max(0, Math.round(input.timeMs)),
      Boolean(input.paused),
      Math.max(1, Math.round(input.fps)),
      Math.max(0, Math.round(input.frame)),
      input.fromClientId,
    ]
  );

  const row = res.rows[0];
  return {
    sessionId: row.session_id,
    mediaId: row.media_id ?? null,
    timeMs: Number(row.time_ms) || 0,
    paused: Boolean(row.paused),
    fps: Number(row.fps) || 30,
    frame: Number(row.frame) || 0,
    fromClientId: String(row.from_client_id ?? ''),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
