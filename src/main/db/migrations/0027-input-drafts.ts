import type { Migration } from '../migrate'

/**
 * Adds each task's input draft: what's in its input bar and not sent yet, so it's there again after a relaunch or a
 * crash. A task has at most one, and none while its input bar is empty. The draft's pasted images go in `images`, as a
 * message's do, with a third kind of owner (`draft_task_id`). Allowing it changes the table's CHECK, which means
 * rebuilding the table; nothing references `images`, so its rows are copied across with foreign keys on. A draft goes
 * with its task, and its images with it.
 */
export const inputDraftsMigration: Migration = {
  version: 27,
  name: 'Add the input drafts',
  up(db) {
    db.exec(`
      CREATE TABLE input_drafts (
        task_id TEXT PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE images_next (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages (id) ON DELETE CASCADE,
        queued_message_id TEXT REFERENCES queued_messages (id) ON DELETE CASCADE,
        draft_task_id TEXT REFERENCES input_drafts (task_id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        media_type TEXT NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
        data BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        CHECK ((message_id IS NOT NULL) + (queued_message_id IS NOT NULL) + (draft_task_id IS NOT NULL) = 1)
      ) STRICT;

      INSERT INTO images_next (id, task_id, message_id, queued_message_id, position, media_type, data, created_at)
        SELECT id, task_id, message_id, queued_message_id, position, media_type, data, created_at FROM images;
      DROP TABLE images;
      ALTER TABLE images_next RENAME TO images;

      CREATE INDEX images_message ON images (message_id, position);
      CREATE INDEX images_queued_message ON images (queued_message_id, position);
      CREATE INDEX images_draft ON images (draft_task_id, position);
    `)
  },
}
