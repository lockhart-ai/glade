import type { Database } from 'better-sqlite3'
import type { OpenFiles } from '../../../shared/domain'
import { noOpenFiles } from '../../../shared/files'
import { Row, RowError } from './rows'

function parsePaths(row: Row): string[] {
  const paths = row.json('paths')
  if (!Array.isArray(paths) || !paths.every((path): path is string => typeof path === 'string')) {
    throw new RowError('open_files', 'paths', 'expected a JSON array of strings')
  }
  return paths
}

/** The files open in a task's Files tab; none when it has never had one open. */
export function getOpenFiles(db: Database, taskId: string): OpenFiles {
  const raw: unknown = db.prepare('SELECT paths, active_path FROM open_files WHERE task_id = ?').get(taskId)
  if (raw === undefined) return noOpenFiles(taskId)
  const row = new Row('open_files', raw)
  const paths = parsePaths(row)
  const activePath = row.nullableText('active_path')
  // A showing tab that isn't open can't be: show none rather than a tab that isn't there.
  return { taskId, paths, activePath: activePath !== null && paths.includes(activePath) ? activePath : null }
}

/** Stores a task's open files, replacing what it had. */
export function setOpenFiles(db: Database, { taskId, paths, activePath }: OpenFiles): void {
  db.prepare(
    `INSERT INTO open_files (task_id, paths, active_path) VALUES (?, ?, ?)
    ON CONFLICT (task_id) DO UPDATE SET paths = excluded.paths, active_path = excluded.active_path`,
  ).run(taskId, JSON.stringify(paths), activePath)
}
