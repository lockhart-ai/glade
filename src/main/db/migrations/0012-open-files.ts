import type { Migration } from '../migrate'

/**
 * Adds the files open in each task's Files tab (`OpenFiles` in `src/shared/domain.ts`), so its tabs are still there
 * after a relaunch: one row per task that has had a file open, with the tabs' paths as a JSON array in tab order and
 * the one showing. A task without a row has no files open. The open files repository parses them.
 */
export const openFilesMigration: Migration = {
  version: 12,
  name: 'Add the open files',
  up(db) {
    db.exec(`
      CREATE TABLE open_files (
        task_id TEXT PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
        paths TEXT NOT NULL CHECK (json_valid(paths) AND json_type(paths) = 'array'),
        active_path TEXT
      ) STRICT;
    `)
  },
}
