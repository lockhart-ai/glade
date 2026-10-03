import type { Migration } from '../migrate'

/**
 * Marks the messages sent with Broadcast (#489): one message to every active task at once, which each task's chat tags
 * as a broadcast. The flag is on the chat log's messages and on the queued ones, since a busy task gets a broadcast in
 * its queue, and it stays a broadcast once delivered. Every message sent before this was to its own task alone.
 */
export const broadcastMessagesMigration: Migration = {
  version: 55,
  name: 'Mark the messages sent with Broadcast',
  up(db) {
    db.exec(`
      ALTER TABLE messages ADD COLUMN broadcast INTEGER NOT NULL DEFAULT 0 CHECK (broadcast IN (0, 1));
      ALTER TABLE queued_messages ADD COLUMN broadcast INTEGER NOT NULL DEFAULT 0 CHECK (broadcast IN (0, 1));
    `)
  },
}
