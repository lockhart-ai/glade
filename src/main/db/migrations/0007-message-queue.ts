import type { Migration } from '../migrate'

/**
 * Adds each task's message queue: the messages the user sent while the agent was working, waiting to be delivered
 * after its current step. Ordered by `seq`, numbered per task like the chat log's; a message leaves the queue (its row
 * is deleted) when it's delivered or removed, so gaps in `seq` are normal.
 */
export const messageQueueMigration: Migration = {
  version: 7,
  name: 'Add the message queue',
  up(db) {
    db.exec(`
      CREATE TABLE queued_messages (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (task_id, seq)
      ) STRICT;
    `)
  },
}
