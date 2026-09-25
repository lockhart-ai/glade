import type { Migration } from '../migrate'

/**
 * Indexes the task list's Done section, which the window loads a page at a time (`tasks.listDone`): a workspace's
 * done, unpinned tasks in the list's order, most recently updated first and ties by id, so each page is a short range
 * scan however many done tasks there are.
 */
export const doneListIndexMigration: Migration = {
  version: 21,
  name: 'Index the Done section',
  up(db) {
    db.exec(`CREATE INDEX tasks_done_list ON tasks (workspace_id, state, pinned, updated_at DESC, id);`)
  },
}
