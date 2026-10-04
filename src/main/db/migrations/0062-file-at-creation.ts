import type { Migration } from '../migrate'

/**
 * Adds what filing a child as it's made keeps (P16-04, #495; `../../todo-hub/filing`). Nothing reads or writes either
 * while the hidden `todoHubEnabled` setting is off, but for `session_context.todo_hub`, which is read with its row and
 * stays 0.
 *
 * - `owed_filings`: a child the task's own agent made, with the hub on, in a call that named no todo (or one that
 *   isn't in its list), until the agent files it. It's what Glade holds the end of a turn for, and asks about again at
 *   the end of the next one: kept here so a relaunch doesn't forget what's owed. A child is named as in `child_ids`,
 *   by its kind and its own key within that kind. What the task made before the hub, and what was added with no call
 *   of the agent's (a link you added, an artifact added through the control API), is never here. Goes with its task.
 * - `session_context.todo_hub`: whether the task's session has been told that Glade files what it makes under its
 *   todos, and how to name one (`TODO_HUB_LINES` in `../../agent/system-prompt`). Claude Code keeps a session's prompt
 *   when it resumes it, so a session that started with the hub off, and resumes with it on, is sent those lines once,
 *   ahead of its next message. Every session recorded before this counts as not told: 0.
 */
export const fileAtCreationMigration: Migration = {
  version: 62,
  name: 'Add the filings a task’s agent owes, and whether its session was told of the todo hub',
  up(db) {
    db.exec(`
      CREATE TABLE owed_filings (
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('file', 'link', 'subagent', 'watcher', 'commit')),
        key TEXT NOT NULL CHECK (key <> ''),
        made_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, kind, key)
      ) STRICT;

      ALTER TABLE session_context ADD COLUMN todo_hub INTEGER NOT NULL DEFAULT 0 CHECK (todo_hub IN (0, 1));
    `)
  },
}
