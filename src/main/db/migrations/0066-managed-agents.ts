import type { Migration } from '../migrate'
import { Row } from '../repositories/rows'

/** Also repairs databases made by earlier revisions of the unmerged OpenRouter branch. */
export const managedAgentsMigration: Migration = {
  version: 66,
  name: 'Keep independently routed SDK children and upgrade OpenRouter preview databases',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS openrouter_usage (
        id INTEGER PRIMARY KEY REFERENCES openrouter_connection (id) ON DELETE CASCADE CHECK (id = 1),
        reading TEXT CHECK (reading IS NULL OR json_valid(reading)), error TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sdk_transcript_failures (
        owner TEXT NOT NULL, session_id TEXT NOT NULL,
        task_id TEXT REFERENCES tasks (id) ON DELETE CASCADE,
        reason TEXT NOT NULL CHECK (reason IN ('importing', 'mirror_error')), config_dir TEXT,
        CHECK (owner = coalesce(task_id, '')), PRIMARY KEY (owner, session_id)
      ) STRICT;
    `)
    // Rebuilding preserves markers and allows 'importing' even on the first preview's narrower CHECK.
    const columns = db
      .prepare('PRAGMA table_info(sdk_transcript_failures)')
      .all()
      .map((raw) => new Row('table_info', raw).text('name'))
    const config = columns.includes('config_dir') ? 'config_dir' : 'NULL'
    db.exec(`
      CREATE TABLE sdk_transcript_failures_next (
        owner TEXT NOT NULL, session_id TEXT NOT NULL,
        task_id TEXT REFERENCES tasks (id) ON DELETE CASCADE,
        reason TEXT NOT NULL CHECK (reason IN ('importing', 'mirror_error')), config_dir TEXT,
        CHECK (owner = coalesce(task_id, '')), PRIMARY KEY (owner, session_id)
      ) STRICT;
      INSERT INTO sdk_transcript_failures_next SELECT owner, session_id, task_id, reason, ${config} FROM sdk_transcript_failures;
      DROP TABLE sdk_transcript_failures;
      ALTER TABLE sdk_transcript_failures_next RENAME TO sdk_transcript_failures;
      CREATE TABLE sdk_transcript_backups (
        owner TEXT NOT NULL, session_id TEXT NOT NULL,
        task_id TEXT REFERENCES tasks (id) ON DELETE CASCADE,
        entries TEXT NOT NULL CHECK (json_valid(entries)),
        CHECK (owner = coalesce(task_id, '')), PRIMARY KEY (owner, session_id)
      ) STRICT;
      CREATE TABLE managed_agents (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        tool_use_id TEXT NOT NULL,
        model TEXT NOT NULL,
        session_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'stopped')),
        result TEXT NOT NULL DEFAULT '',
        UNIQUE (task_id, tool_use_id)
      ) STRICT;
    `)
  },
}
