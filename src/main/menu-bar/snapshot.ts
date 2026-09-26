/**
 * What's in flight, read from the database (`menuBarSnapshot` in `src/shared/menuBar.ts` works it out): every
 * workspace's active tasks, when each one's current turn started, and the latest notifications sent.
 */
import type { Database } from 'better-sqlite3'
import { TaskState } from '../../shared/domain'
import { menuBarSnapshot, RECENT_NOTIFICATIONS_SHOWN, type MenuBarSnapshot } from '../../shared/menuBar'
import { lastTurn, turnStartedAt } from '../db/repositories/messages'
import { listRecentNotifications } from '../db/repositories/notifications'
import { getTasks, listTaskIds } from '../db/repositories/tasks'
import { listWorkspaces } from '../db/repositories/workspaces'

/** What's in flight across every workspace, as the menu bar shows it. */
export function readMenuBarSnapshot(db: Database): MenuBarSnapshot {
  return menuBarSnapshot({
    tasks: getTasks(db, listTaskIds(db, null, TaskState.Active)),
    workspaces: listWorkspaces(db),
    turnStartedAt: (taskId) => turnStartedAt(db, taskId, lastTurn(db, taskId)),
    recent: listRecentNotifications(db, RECENT_NOTIFICATIONS_SHOWN),
  })
}
