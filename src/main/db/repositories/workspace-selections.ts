import type { Database } from 'better-sqlite3'
import { Row } from './rows'

/** The task last selected in a workspace, or undefined when none is. */
export function getWorkspaceSelection(db: Database, workspaceId: string): string | undefined {
  const raw: unknown = db.prepare('SELECT task_id FROM workspace_selections WHERE workspace_id = ?').get(workspaceId)
  return raw === undefined ? undefined : new Row('workspace_selections', raw).text('task_id')
}

/** Records the task selected in a workspace, replacing the one before. */
export function setWorkspaceSelection(db: Database, workspaceId: string, taskId: string): void {
  db.prepare(
    `INSERT INTO workspace_selections (workspace_id, task_id) VALUES (?, ?)
    ON CONFLICT (workspace_id) DO UPDATE SET task_id = excluded.task_id`,
  ).run(workspaceId, taskId)
}

/** Records that no task is selected in a workspace. */
export function clearWorkspaceSelection(db: Database, workspaceId: string): void {
  db.prepare('DELETE FROM workspace_selections WHERE workspace_id = ?').run(workspaceId)
}
