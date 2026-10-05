import type { Migration } from '../migrate'

export const openRouterMigration: Migration = {
  version: 65,
  name: 'Keep encrypted OpenRouter credentials, curated routes and SDK transcripts',
  up(db) {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN subagent_model TEXT;
      CREATE TABLE openrouter_connection (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        encrypted_key BLOB NOT NULL,
        models TEXT NOT NULL CHECK (json_valid(models)),
        providers TEXT NOT NULL CHECK (json_valid(providers))
      ) STRICT;
      CREATE TABLE openrouter_choices (
        id TEXT PRIMARY KEY,
        choice TEXT NOT NULL CHECK (json_valid(choice))
      ) STRICT;
      CREATE TABLE sdk_transcripts (
        owner TEXT NOT NULL,
        project_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        subpath TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        entry TEXT NOT NULL CHECK (json_valid(entry)),
        ordinal INTEGER NOT NULL,
        task_id TEXT REFERENCES tasks (id) ON DELETE CASCADE,
        CHECK (owner = coalesce(task_id, '')),
        PRIMARY KEY (owner, project_key, session_id, subpath, entry_key),
        UNIQUE (owner, project_key, session_id, subpath, ordinal)
      ) STRICT;
      CREATE TABLE task_model_switches (
        task_id TEXT PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
        previous_model TEXT NOT NULL,
        next_model TEXT NOT NULL,
        label TEXT NOT NULL
      ) STRICT;
      CREATE TABLE model_switch_history (
        event_id TEXT PRIMARY KEY REFERENCES tool_events (id) ON DELETE CASCADE,
        previous_model TEXT NOT NULL,
        next_model TEXT NOT NULL,
        label TEXT NOT NULL
      ) STRICT;
      CREATE TABLE openrouter_generations (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks (id) ON DELETE CASCADE,
        choice_id TEXT NOT NULL,
        actual_provider TEXT,
        cost_usd REAL,
        CHECK (cost_usd IS NULL OR cost_usd >= 0)
      ) STRICT;
    `)
  },
}
