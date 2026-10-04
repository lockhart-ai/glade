import type { Migration } from '../migrate'

/**
 * Adds what the todo hub keeps (P16, #491; `src/shared/todoHub.ts`): the short id of each of a task's children, which
 * todo each is under, and how you left each todo's panel. Nothing reads or writes any of them while the hidden
 * `todoHubEnabled` setting is off.
 *
 * A child is named by its kind and its own key within that kind: an artifact's path or URL, the `tool_use` id of the
 * call that started a subagent or a watcher, a commit's hash and working tree.
 *
 * - `child_ids`: the number of a child's short id (`c3` is 3), which Glade shows the agent and the agent files
 *   children by. Numbered from 1 within the task, in the order Glade first named them. A row is never changed or
 *   removed while its task is there, so an id means the same child for the life of the task and is never given to
 *   another.
 * - `child_filings`: a child filed under a todo. `todo_id` is Claude Code's own id for the todo (`Task #N`), never the
 *   placeholder's reserved one; `source` is how it was filed (named in the call that made it, filed by the agent when
 *   Glade asked, inherited from the subagent that made it, or moved). One filing per child, so filing it again
 *   replaces the last. A todo that's deleted leaves its filings behind: they name a todo that's no longer in the list,
 *   which the hub shows under "Not under a todo".
 * - `todo_panels`: whether a todo's panel is open, and which of its children it shows, one row per todo you changed
 *   from how it starts (closed, showing all). The placeholder group's is kept under the reserved id `unfiled`.
 *
 * All three go with their task.
 */
export const todoHubMigration: Migration = {
  version: 59,
  name: 'Add the todo hub’s child ids, filings and panel state',
  up(db) {
    db.exec(`
      CREATE TABLE child_ids (
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        number INTEGER NOT NULL CHECK (number > 0),
        kind TEXT NOT NULL CHECK (kind IN ('file', 'link', 'subagent', 'watcher', 'commit')),
        key TEXT NOT NULL CHECK (key <> ''),
        PRIMARY KEY (task_id, kind, key),
        UNIQUE (task_id, number)
      ) STRICT;

      CREATE TABLE child_filings (
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('file', 'link', 'subagent', 'watcher', 'commit')),
        key TEXT NOT NULL CHECK (key <> ''),
        todo_id TEXT NOT NULL CHECK (todo_id <> '' AND todo_id <> 'unfiled'),
        source TEXT NOT NULL CHECK (source IN ('named', 'asked', 'inherited', 'moved')),
        filed_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, kind, key)
      ) STRICT;

      CREATE TABLE todo_panels (
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        todo_id TEXT NOT NULL CHECK (todo_id <> ''),
        open INTEGER NOT NULL CHECK (open IN (0, 1)),
        filter TEXT NOT NULL CHECK (filter IN ('all', 'file', 'link', 'subagent', 'watcher', 'commit')),
        PRIMARY KEY (task_id, todo_id)
      ) STRICT;
    `)
  },
}
