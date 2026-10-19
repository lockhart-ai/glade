import type { Migration } from '../migrate'
import { SEARCH_TRIGGERS } from './0016-search-index'

/**
 * Adds task-to-task messages (#710): `source` gains `task`, and both `messages` and `queued_messages` gain
 * `sender_task_id`, the id of the task that sent it (null for every other message). Changing the CHECK on `source`
 * means rebuilding both tables (SQLite's "other kinds of table schema changes"), with foreign keys off
 * (`rebuildsReferencedTable`): images, pasted blocks, attached files and search documents reference messages, and
 * their rows keep pointing at the same message ids through the copy. The search trigger on `messages` goes with the
 * old table, so it's created again (`SEARCH_TRIGGERS`, migration 0016).
 */
export const taskMessageSourceMigration: Migration = {
  version: 83,
  name: 'Add the task message source and its sender',
  rebuildsReferencedTable: true,
  up(db) {
    db.exec(`
      CREATE TABLE messages_new (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'agent')),
        body TEXT NOT NULL,
        turn INTEGER NOT NULL CHECK (turn >= 1),
        created_at INTEGER NOT NULL,
        duration_ms INTEGER CHECK (duration_ms >= 0),
        files_changed INTEGER CHECK (files_changed >= 0),
        lines_added INTEGER CHECK (lines_added >= 0),
        lines_removed INTEGER CHECK (lines_removed >= 0),
        source TEXT CHECK (source IN ('broadcast', 'github', 'task')),
        sender_task_id TEXT,
        UNIQUE (task_id, seq)
      ) STRICT;
      INSERT INTO messages_new (id, task_id, seq, role, body, turn, created_at, duration_ms, files_changed,
        lines_added, lines_removed, source)
        SELECT id, task_id, seq, role, body, turn, created_at, duration_ms, files_changed, lines_added,
        lines_removed, source FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_new RENAME TO messages;

      CREATE TABLE queued_messages_new (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        source TEXT CHECK (source IN ('broadcast', 'github', 'task')),
        sender_task_id TEXT,
        UNIQUE (task_id, seq)
      ) STRICT;
      INSERT INTO queued_messages_new (id, task_id, seq, body, created_at, source)
        SELECT id, task_id, seq, body, created_at, source FROM queued_messages;
      DROP TABLE queued_messages;
      ALTER TABLE queued_messages_new RENAME TO queued_messages;

      CREATE TRIGGER messages_search_after_insert AFTER INSERT ON messages BEGIN
        INSERT INTO search_documents (task_id, workspace_id, field, message_id, body)
        SELECT new.task_id, tasks.workspace_id, 'message', new.id, new.body FROM tasks WHERE tasks.id = new.task_id;
      END;
    `)
    const present = new Set(
      (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger'").all() as { name: string }[]).map(
        ({ name }) => name,
      ),
    )
    for (const trigger of SEARCH_TRIGGERS) {
      if (!present.has(trigger)) throw new Error(`Migration 83 left out the ${trigger} trigger`)
    }
  },
}
