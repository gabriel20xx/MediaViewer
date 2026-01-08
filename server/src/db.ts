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
