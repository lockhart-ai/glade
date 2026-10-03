import type { Migration } from '../migrate'

/**
 * Adds the sandbox grants (P15, #449; `SandboxGrant` in `src/shared/sandbox.ts`): the folders and network domains a
 * task's agent may use beyond its workspace root, each granted Glade-wide, for a workspace or for a task. A
 * workspace's grants go with the workspace and a task's with the task; Glade-wide ones stay. One row per folder or
 * domain in each scope: a folder granted again keeps its row, its access widened from `read` to `read_write` if asked.
 */
export const sandboxGrantsMigration: Migration = {
  version: 54,
  name: 'Add the sandbox grants',
  up(db) {
    db.exec(`
      CREATE TABLE sandbox_grants (
        scope TEXT NOT NULL CHECK (scope IN ('glade', 'workspace', 'task')),
        workspace_id TEXT REFERENCES workspaces (id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks (id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('folder', 'domain')),
        value TEXT NOT NULL CHECK (value <> ''),
        access TEXT,
        created_at INTEGER NOT NULL,
        CHECK (
          (scope = 'glade' AND workspace_id IS NULL AND task_id IS NULL)
          OR (scope = 'workspace' AND workspace_id IS NOT NULL AND task_id IS NULL)
          OR (scope = 'task' AND task_id IS NOT NULL AND workspace_id IS NULL)
        ),
        CHECK (
          (kind = 'folder' AND access IS NOT NULL AND access IN ('read', 'read_write'))
          OR (kind = 'domain' AND access IS NULL)
        )
      ) STRICT;
      CREATE UNIQUE INDEX sandbox_grants_by_scope
        ON sandbox_grants (scope, ifnull(workspace_id, ''), ifnull(task_id, ''), kind, value);
      CREATE INDEX sandbox_grants_by_workspace ON sandbox_grants (workspace_id) WHERE workspace_id IS NOT NULL;
      CREATE INDEX sandbox_grants_by_task ON sandbox_grants (task_id) WHERE task_id IS NOT NULL;
    `)
  },
}
