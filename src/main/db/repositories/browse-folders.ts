import type { Database } from 'better-sqlite3'

/** One of a task's Browse tab folders opened or closed. */
export interface BrowseFolderChange {
  readonly taskId: string
  /** Relative to the workspace root. */
  readonly path: string
  readonly expanded: boolean
}

/** Remembers whether a folder of a task's Browse tab is open. */
export function setBrowseFolderExpanded(db: Database, { taskId, path, expanded }: BrowseFolderChange): void {
  if (expanded) db.prepare('INSERT OR IGNORE INTO browse_folders (task_id, path) VALUES (?, ?)').run(taskId, path)
  else db.prepare('DELETE FROM browse_folders WHERE task_id = ? AND path = ?').run(taskId, path)
}

/** The folders open in a task's Browse tab, by path. None when it has never had one open. */
export function listBrowseFolders(db: Database, taskId: string): string[] {
  return db
    .prepare('SELECT path FROM browse_folders WHERE task_id = ? ORDER BY path')
    .pluck()
    .all(taskId)
    .filter((path): path is string => typeof path === 'string')
}
