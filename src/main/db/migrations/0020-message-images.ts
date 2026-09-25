import type { Migration } from '../migrate'

/**
 * Adds the images pasted into messages, stored in the database with their message so the chat shows them after a
 * relaunch. Each image belongs to exactly one message: one in the chat log (`message_id`) or one still waiting in the
 * queue (`queued_message_id`), which it moves to when the queue is delivered. `position` keeps them in the order they
 * were pasted. An image goes with its message, queued message or task.
 */
export const messageImagesMigration: Migration = {
  version: 20,
  name: 'Add the images pasted into messages',
  up(db) {
    db.exec(`
      CREATE TABLE images (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages (id) ON DELETE CASCADE,
        queued_message_id TEXT REFERENCES queued_messages (id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        media_type TEXT NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
        data BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        CHECK ((message_id IS NULL) != (queued_message_id IS NULL))
      ) STRICT;

      CREATE INDEX images_message ON images (message_id, position);
      CREATE INDEX images_queued_message ON images (queued_message_id, position);
    `)
  },
}
