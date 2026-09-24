import type { Migration } from '../migrate'

/**
 * Adds each workspace's selection: the task that was last selected in it, so switching back to a workspace shows that
 * task again. One row per workspace that has one; no row means no task selected there. A row goes with its workspace,
 * and with its task when the task is deleted.
 */
export const workspaceSelectionsMigration: Migration = {
  version: 16,
  name: 'Add each workspace’s selected task',
  up(db) {
    db.exec(`
      CREATE TABLE workspace_selections (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE
      ) STRICT;
    `)
  },
}
