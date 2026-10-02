import type { Migration } from '../migrate'

/**
 * Adds the files attached to messages (#396): each dropped onto the input bar or pasted from Finder, copied into the
 * workspace (`../../attachments/attachments.ts`), and kept here by the copy's name, path (relative to the workspace
 * root), size and kind, exactly as pasted blocks are kept (migration 45). A file belongs to one message in the chat log
 * (`message_id`), one still waiting in the queue (`queued_message_id`), which it moves to when the queue is delivered,
 * or a task's input draft (`draft_task_id`); `position` keeps the files in the order they were attached. The copy on
 * disk isn't the database's: deleting the task deletes the task's folder of them.
 */
export const attachedFilesMigration: Migration = {
  version: 46,
  name: 'Add the files attached to messages',
  up(db) {
    db.exec(`
      CREATE TABLE attached_files (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages (id) ON DELETE CASCADE,
        queued_message_id TEXT REFERENCES queued_messages (id) ON DELETE CASCADE,
        draft_task_id TEXT REFERENCES input_drafts (task_id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        size INTEGER NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        CHECK ((message_id IS NOT NULL) + (queued_message_id IS NOT NULL) + (draft_task_id IS NOT NULL) = 1)
      ) STRICT;

      CREATE INDEX attached_files_message ON attached_files (message_id, position);
      CREATE INDEX attached_files_queued_message ON attached_files (queued_message_id, position);
      CREATE INDEX attached_files_draft ON attached_files (draft_task_id, position);
      CREATE INDEX attached_files_task_path ON attached_files (task_id, path);
    `)
  },
}
