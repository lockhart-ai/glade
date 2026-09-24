import type { Migration } from '../migrate'

/**
 * Adds the artifacts: the files the agent declared as a task's deliverables with `add_artifact` (`Artifact` in
 * `src/shared/domain.ts`). One row per task and path, so declaring a path again renames it rather than adding another.
 * They go with their task only when it's deleted: a done task keeps them.
 */
export const artifactsMigration: Migration = {
  version: 15,
  name: 'Add the artifacts',
  up(db) {
    db.exec(`
      CREATE TABLE artifacts (
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, path)
      ) STRICT;
    `)
  },
}
