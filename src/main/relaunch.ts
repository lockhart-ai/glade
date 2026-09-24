/**
 * Telling a crash from a clean quit, for the relaunch notice (`../shared/relaunchNotice`).
 *
 * The app marks the database as running when it starts and clears the mark when it quits. A mark still there on the
 * next launch means the app never got to quit: it crashed or was force-quit. Tasks mid-turn are resumed on launch
 * either way (quitting leaves their turns to the next launch), but only a crash that cut tasks off mid-turn gets the
 * notice: after a clean quit, or a crash with nothing running, nothing unexpected happened to any task.
 *
 * The mark lives in the `ui_state` table under a key of main's own, which isn't a `UiStateKey`, so the windows never
 * see it (`listUiState` skips it).
 */
import type { Database } from 'better-sqlite3'
import { UiStateKey } from '../shared/domain'
import { serializeRelaunchNotice } from '../shared/relaunchNotice'
import { setUiState } from './db/repositories/ui-state'

/** The `ui_state` key of the running mark. Main's own: not a `UiStateKey`. */
export const RUNNING_MARK_KEY = 'app_running'

/** Marks the app as running. Answers whether it was already marked: the last run never quit, it crashed. */
export function markRunning(db: Database, now: number = Date.now()): boolean {
  return db.transaction(() => {
    const crashed = db.prepare('SELECT 1 FROM ui_state WHERE key = ?').get(RUNNING_MARK_KEY) !== undefined
    db.prepare(
      'INSERT INTO ui_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    ).run(RUNNING_MARK_KEY, String(now))
    return crashed
  })()
}

/** Clears the running mark, as the app quits. */
export function markQuit(db: Database): void {
  db.prepare('DELETE FROM ui_state WHERE key = ?').run(RUNNING_MARK_KEY)
}

/**
 * Saves the relaunch notice when the last run crashed and `resumedTaskIds` (the tasks it cut off mid-turn, whose agents
 * picked up again) has any. Otherwise leaves whatever notice is there, dismissed or not, as it is.
 */
export function noteRelaunch(db: Database, crashed: boolean, resumedTaskIds: readonly string[]): void {
  if (!crashed || resumedTaskIds.length === 0) return
  setUiState(db, { key: UiStateKey.RelaunchNotice, value: serializeRelaunchNotice({ taskIds: resumedTaskIds }) })
}
