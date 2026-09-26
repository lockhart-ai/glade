import type { Migration } from '../migrate'

/**
 * For the Artifacts tab's rows in date groups (#307):
 *
 * - `artifacts.modified_at` and `artifacts.missing`: when the artifact's file last changed, as last seen, and whether
 *   it was gone then. The tab lists artifacts by it, newest first; a file that's gone keeps its last known time. Every
 *   artifact declared before this hasn't been looked at yet: null, and not missing, until it is.
 * - `artifact_groups`: which of a task's date groups (`ArtifactDateGroup` in `src/shared/domain.ts`) you opened or
 *   folded, one row per group you've toggled. A group without one shows as it starts: Today and Yesterday open, the
 *   rest folded. They go with their task.
 */
export const artifactGroupsMigration: Migration = {
  version: 41,
  name: 'Add the artifacts’ file times and the date groups opened or folded',
  up(db) {
    db.exec(`
      ALTER TABLE artifacts ADD COLUMN modified_at INTEGER;
      ALTER TABLE artifacts ADD COLUMN missing INTEGER NOT NULL DEFAULT 0 CHECK (missing IN (0, 1));
      CREATE TABLE artifact_groups (
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        date_group TEXT NOT NULL
          CHECK (date_group IN ('today', 'yesterday', 'this_week', 'last_week', 'this_month', 'older')),
        open INTEGER NOT NULL CHECK (open IN (0, 1)),
        PRIMARY KEY (task_id, date_group)
      ) STRICT;
    `)
  },
}
