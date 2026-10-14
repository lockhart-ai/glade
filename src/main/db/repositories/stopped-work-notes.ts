// The note a limit-switch leaves a task (migration 77): what background work the switch stopped, prepended once to
// the destination session's next prompt. Kept so a relaunch between the switch and the next prompt doesn't lose it. A
// task has at most one, and none once the note has been given.
import type { Database } from 'better-sqlite3'
import type { EpochMs } from '../../../shared/domain'
import { Row } from './rows'

/** A task's switch note, or null when it has none. */
export function getStoppedWorkNote(db: Database, taskId: string): string | null {
  const row: unknown = db.prepare('SELECT note FROM stopped_work_notes WHERE task_id = ?').get(taskId)
  if (row === undefined) return null
  return new Row('stopped_work_notes', row).text('note')
}

/** Stores a task's switch note as it now is, replacing the one it had; null removes it. */
export function setStoppedWorkNote(db: Database, taskId: string, note: string | null, now: EpochMs = Date.now()): void {
  if (note === null) {
    db.prepare('DELETE FROM stopped_work_notes WHERE task_id = ?').run(taskId)
    return
  }
  db.prepare(
    `INSERT INTO stopped_work_notes (task_id, note, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (task_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
  ).run(taskId, note, now)
}
