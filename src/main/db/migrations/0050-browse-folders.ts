import type { Migration } from '../migrate'

/**
 * Adds the folders open in each task's Browse tab (#398), so its tree opens as you left it after a relaunch: one row
 * per folder open, by its path relative to the workspace root. A task without any shows its root's entries only. They
 * go with their task.
 */
export const browseFoldersMigration: Migration = {
  version: 50,
  name: 'Add the folders open in the Browse tab',
  up(db) {
    db.exec(`
      CREATE TABLE browse_folders (
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        path TEXT NOT NULL CHECK (path <> ''),
        PRIMARY KEY (task_id, path)
      ) STRICT;
    `)
  },
}
