import type { Migration } from '../migrate'

/**
 * Adds the text pasted into messages, marked for the agent (#363): each big paste (more than one line, or ~80
 * characters or more) becomes a block, kept apart from what was typed, exactly as images already are (migration 20).
 * A block belongs to one message in the chat log (`message_id`), one still waiting in the queue (`queued_message_id`),
 * which it moves to when the queue is delivered, or a task's input draft (`draft_task_id`); `position` keeps blocks in
 * the order their tokens appear among the typed text. `tag_id` is the short random id in the block's inline token and
 * its `<pasted_content id="…">` tag to the agent (`shared/pastedContent.ts`); `id` is its own row's id, so `tag_id`
 * only has to be unique within one message, not across the whole database.
 *
 * A block's text is also indexed for search, alongside its message (`search_documents`): the trigger below appends it
 * to the message's existing row (inserted by `messages_search_after_insert`, migration 16), so a search matches text
 * inside a pasted block too, without a token or a tag ever reaching the index.
 */
export const pastedBlocksMigration: Migration = {
  version: 45,
  name: 'Add the text pasted into messages',
  up(db) {
    db.exec(`
      CREATE TABLE pasted_blocks (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages (id) ON DELETE CASCADE,
        queued_message_id TEXT REFERENCES queued_messages (id) ON DELETE CASCADE,
        draft_task_id TEXT REFERENCES input_drafts (task_id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        tag_id TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        CHECK ((message_id IS NOT NULL) + (queued_message_id IS NOT NULL) + (draft_task_id IS NOT NULL) = 1)
      ) STRICT;

      CREATE INDEX pasted_blocks_message ON pasted_blocks (message_id, position);
      CREATE INDEX pasted_blocks_queued_message ON pasted_blocks (queued_message_id, position);
      CREATE INDEX pasted_blocks_draft ON pasted_blocks (draft_task_id, position);

      CREATE TRIGGER pasted_blocks_search_after_insert AFTER INSERT ON pasted_blocks
        WHEN new.message_id IS NOT NULL BEGIN
        UPDATE search_documents SET body = body || char(10) || new.text
          WHERE message_id = new.message_id AND field = 'message';
      END;
    `)
  },
}
