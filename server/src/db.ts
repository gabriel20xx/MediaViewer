import { Pool } from 'pg';

export type Db = {
  pool: Pool;
  close(): Promise<void>;
};

export function createDb(databaseUrl: string): Db {
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    pool,
    async close() {
      await pool.end();
    },
  };
}

export async function ensureSchema(db: Db): Promise<void> {
  // Idempotent bootstrap so we don't need a separate migrations tool.
  // IMPORTANT: Creating indexes can fail on older DBs if columns were added later.
  // So: create tables first, then backfill columns, then create indexes.

  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS media_items (
      id TEXT PRIMARY KEY,
      rel_path TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      ext TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      modified_ms BIGINT NOT NULL,
      has_funscript BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS playback_states (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      media_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      time_ms INTEGER NOT NULL,
      fps INTEGER NOT NULL DEFAULT 30,
      frame INTEGER NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (client_id, media_id)
    );

    CREATE TABLE IF NOT EXISTS sync_playback_state (
      session_id TEXT PRIMARY KEY,
      media_id TEXT,
      time_ms INTEGER NOT NULL DEFAULT 0,
      paused BOOLEAN NOT NULL DEFAULT TRUE,
      fps INTEGER NOT NULL DEFAULT 30,
      frame INTEGER NOT NULL DEFAULT 0,
      from_client_id TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await db.pool.query(`
    ALTER TABLE media_items
      ADD COLUMN IF NOT EXISTS title TEXT;

    ALTER TABLE media_items
      ADD COLUMN IF NOT EXISTS duration_ms INTEGER;

    ALTER TABLE media_items
      ADD COLUMN IF NOT EXISTS width INTEGER;

    ALTER TABLE media_items
      ADD COLUMN IF NOT EXISTS height INTEGER;

    ALTER TABLE media_items
      ADD COLUMN IF NOT EXISTS funscript_action_count INTEGER;

    ALTER TABLE media_items
      ADD COLUMN IF NOT EXISTS funscript_avg_speed REAL;

    ALTER TABLE media_items
      ADD COLUMN IF NOT EXISTS is_vr BOOLEAN NOT NULL DEFAULT FALSE;

    ALTER TABLE media_items
      ADD COLUMN IF NOT EXISTS vr_fov SMALLINT;

    ALTER TABLE media_items
      ADD COLUMN IF NOT EXISTS vr_stereo TEXT;

    ALTER TABLE media_items
      ADD COLUMN IF NOT EXISTS vr_projection TEXT;
  `);

  await db.pool.query(`
    CREATE INDEX IF NOT EXISTS idx_media_items_modified_ms ON media_items (modified_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_media_items_filename ON media_items (filename);
    CREATE INDEX IF NOT EXISTS idx_media_items_title ON media_items (title);
    CREATE INDEX IF NOT EXISTS idx_media_items_duration_ms ON media_items (duration_ms);
    CREATE INDEX IF NOT EXISTS idx_media_items_resolution ON media_items (width, height);
    CREATE INDEX IF NOT EXISTS idx_media_items_funscript_speed ON media_items (funscript_avg_speed);
  `);
}
