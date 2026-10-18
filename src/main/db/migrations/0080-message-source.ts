import type { Migration } from '../migrate'

/**
 * Replaces `messages.broadcast` and `queued_messages.broadcast` (#489, migration 0055) with `source` (#682): a message
 * now says *which* of Glade's own sources it's from, not only whether it's a broadcast, so the chat can tag a note one
 * of Glade's watchers left (`MessageSource.Github`) the same way it tags a broadcast, without a second flag that could
 * disagree with the first. `broadcast = 1` becomes `source = 'broadcast'`; `broadcast = 0` becomes `source = NULL`,
 * read as a message with no tag (your own words, or the agent's).
 */
export const messageSourceMigration: Migration = {
  version: 80,
  name: 'Replace the broadcast flag with a message source',
  up(db) {
    db.exec(`
      ALTER TABLE messages ADD COLUMN source TEXT CHECK (source IN ('broadcast', 'github'));
      UPDATE messages SET source = 'broadcast' WHERE broadcast = 1;
      ALTER TABLE messages DROP COLUMN broadcast;

      ALTER TABLE queued_messages ADD COLUMN source TEXT CHECK (source IN ('broadcast', 'github'));
      UPDATE queued_messages SET source = 'broadcast' WHERE broadcast = 1;
      ALTER TABLE queued_messages DROP COLUMN broadcast;
    `)
  },
}
