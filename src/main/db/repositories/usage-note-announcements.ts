// The usage a task's agent was last told of mid-turn (migration 78): the session and weekly percentages and the
// OpenRouter spend its last threshold note named, so a relaunch doesn't repeat one. A task has at most one row.
import type { Database } from 'better-sqlite3'
import type { EpochMs } from '../../../shared/domain'
import type { UsageAnnounced } from '../../../shared/usage-notes'
import { Row } from './rows'

/** The usage `taskId`'s agent was last told of, or undefined when it has never been told of any. */
export function getUsageNoteAnnouncements(db: Database, taskId: string): UsageAnnounced | undefined {
  const row: unknown = db
    .prepare('SELECT session, week, open_router FROM usage_note_announcements WHERE task_id = ?')
    .get(taskId)
  if (row === undefined) return undefined
  const read = new Row('usage_note_announcements', row)
  return {
    session: read.nullableReal('session'),
    week: read.nullableReal('week'),
    spend: read.nullableReal('open_router'),
  }
}

/** Stores the usage `taskId`'s agent has now been told of, replacing the row it had. */
export function saveUsageNoteAnnouncements(
  db: Database,
  taskId: string,
  announced: UsageAnnounced,
  now: EpochMs,
): void {
  db.prepare(
    `INSERT INTO usage_note_announcements (task_id, session, week, open_router, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (task_id) DO UPDATE SET session = excluded.session, week = excluded.week,
      open_router = excluded.open_router, updated_at = excluded.updated_at`,
  ).run(taskId, announced.session, announced.week, announced.spend, now)
}
