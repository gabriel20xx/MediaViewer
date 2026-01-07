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
  // If you later evolve schema with data preservation guarantees, add migrations.
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
      is_vr BOOLEAN NOT NULL DEFAULT FALSE,
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

    CREATE INDEX IF NOT EXISTS idx_media_items_modified_ms ON media_items (modified_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_media_items_filename ON media_items (filename);

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

  // Backfill older DBs created before is_vr existed.
  await db.pool.query(`
    ALTER TABLE media_items
      ADD COLUMN IF NOT EXISTS is_vr BOOLEAN NOT NULL DEFAULT FALSE;
  `);
}
