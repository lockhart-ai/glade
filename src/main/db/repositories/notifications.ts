// The notifications Glade sent (migration 31), for the menu bar popover's Recent section: kept in the database so
// they're still listed after a relaunch. Only the latest `NOTIFICATIONS_KEPT` are kept; a notification goes with its
// task.
import type { Database } from 'better-sqlite3'
import type { EpochMs } from '../../../shared/domain'
import type { SentNotification } from '../../../shared/menuBar'
import { Row } from './rows'

/**
 * How many of the latest notifications are kept. More than the popover lists (`RECENT_NOTIFICATIONS_SHOWN`), so
 * deleting a task or two still leaves it a full list.
 */
export const NOTIFICATIONS_KEPT = 20

/** The latest first: by when they were sent, and those sent at the same moment by the order they were noted in. */
const LATEST_FIRST = 'ORDER BY sent_at DESC, seq DESC'

/** A notification to note as sent. */
export interface NewNotification {
  readonly taskId: string
  readonly title: string
  readonly body: string
}

function parseNotification(raw: unknown): SentNotification {
  const row = new Row('notifications', raw)
  return {
    seq: row.integer('seq'),
    taskId: row.text('task_id'),
    title: row.text('title'),
    body: row.text('body'),
    sentAt: row.integer('sent_at'),
  }
}

/**
 * Notes a notification as sent at `now`, and forgets all but the latest `kept`. Does nothing for a task that isn't
 * there (any more), answering null.
 */
export function recordNotification(
  db: Database,
  notification: NewNotification,
  now: EpochMs = Date.now(),
  kept: number = NOTIFICATIONS_KEPT,
): SentNotification | null {
  const { taskId, title, body } = notification
  return db.transaction(() => {
    if (db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId) === undefined) return null
    const row: unknown = db
      .prepare('INSERT INTO notifications (task_id, title, body, sent_at) VALUES (?, ?, ?, ?) RETURNING *')
      .get(taskId, title, body, now)
    db.prepare(
      `DELETE FROM notifications WHERE seq NOT IN (SELECT seq FROM notifications ${LATEST_FIRST} LIMIT ?)`,
    ).run(kept)
    return parseNotification(row)
  })()
}

/** The latest notifications sent, newest first, at most `limit` of them. */
export function listRecentNotifications(db: Database, limit: number): SentNotification[] {
  return db.prepare(`SELECT * FROM notifications ${LATEST_FIRST} LIMIT ?`).all(limit).map(parseNotification)
}
