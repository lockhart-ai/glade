import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import {
  LIVE_WATCHER_STATES,
  WatcherKind,
  WatcherState,
  type EpochMs,
  type Watcher,
} from '../../../shared/domain'
import { Row } from './rows'

/** A watcher the agent just started: what the tool call that started it says. */
export interface NewWatcher {
  readonly taskId: string
  readonly kind: WatcherKind
  readonly toolUseId: string
  /** The SDK's id for it, if it's known yet. */
  readonly sdkId: string | null
  readonly label: string
  readonly detail: string
  /** A cron job's 5-field expression, which its next time is worked out from; null for the other kinds. */
  readonly cron: string | null
  readonly schedule: string | null
  readonly recurring: boolean
  readonly state: WatcherState
  readonly nextDueAt: EpochMs | null
  readonly expiresAt: EpochMs | null
}

/** A watcher as Glade keeps it: what the tab shows, and what matching the SDK's reports to it takes. */
export interface StoredWatcher extends Watcher {
  readonly sdkId: string | null
  readonly cron: string | null
  /** Whether you stopped it (Stop in the Watchers tab). */
  readonly stoppedByYou: boolean
}

/** What changes about a watcher; anything left out stays as it is. */
export interface WatcherChange {
  readonly sdkId?: string
  readonly state?: WatcherState
  readonly wakes?: number
  readonly lastWokeAt?: EpochMs
  readonly lastOutput?: string
  readonly nextDueAt?: EpochMs | null
  readonly expiresAt?: EpochMs | null
  readonly outcome?: string | null
  readonly stoppedByYou?: boolean
  readonly endedAt?: EpochMs | null
}

const COLUMNS = `id, task_id, kind, tool_use_id, sdk_id, label, detail, cron, schedule, recurring, state, wakes,
  last_woke_at, last_output, next_due_at, expires_at, outcome, stopped_by_you, started_at, ended_at`

const LIVE = `(${LIVE_WATCHER_STATES.map((state) => `'${state}'`).join(', ')})`

function parseWatcher(raw: unknown): StoredWatcher {
  const row = new Row('watchers', raw)
  return {
    id: row.text('id'),
    taskId: row.text('task_id'),
    kind: row.oneOf('kind', Object.values(WatcherKind)),
    toolUseId: row.text('tool_use_id'),
    sdkId: row.nullableText('sdk_id'),
    label: row.text('label'),
    detail: row.text('detail'),
    cron: row.nullableText('cron'),
    schedule: row.nullableText('schedule'),
    recurring: row.flag('recurring'),
    state: row.oneOf('state', Object.values(WatcherState)),
    wakes: row.integer('wakes'),
    lastWokeAt: row.nullableInteger('last_woke_at'),
    lastOutput: row.nullableText('last_output'),
    nextDueAt: row.nullableInteger('next_due_at'),
    expiresAt: row.nullableInteger('expires_at'),
    outcome: row.nullableText('outcome'),
    stoppedByYou: row.flag('stopped_by_you'),
    startedAt: row.integer('started_at'),
    endedAt: row.nullableInteger('ended_at'),
  }
}

/** A stored watcher as the windows see it: without what only matching the SDK's reports needs. */
export function publicWatcher(stored: StoredWatcher): Watcher {
  return {
    id: stored.id,
    taskId: stored.taskId,
    kind: stored.kind,
    toolUseId: stored.toolUseId,
    label: stored.label,
    detail: stored.detail,
    schedule: stored.schedule,
    recurring: stored.recurring,
    state: stored.state,
    wakes: stored.wakes,
    lastWokeAt: stored.lastWokeAt,
    lastOutput: stored.lastOutput,
    nextDueAt: stored.nextDueAt,
    expiresAt: stored.expiresAt,
    outcome: stored.outcome,
    startedAt: stored.startedAt,
    endedAt: stored.endedAt,
  }
}

/**
 * Adds a watcher the agent started. A tool call starts one at most: adding one for the same call again changes nothing
 * and answers with the one there is.
 */
export function addWatcher(db: Database, watcher: NewWatcher, now: EpochMs = Date.now()): StoredWatcher {
  db.prepare(
    `INSERT INTO watchers (id, task_id, kind, tool_use_id, sdk_id, label, detail, cron, schedule, recurring, state,
      next_due_at, expires_at, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (task_id, tool_use_id) DO NOTHING`,
  ).run(
    randomUUID(),
    watcher.taskId,
    watcher.kind,
    watcher.toolUseId,
    watcher.sdkId,
    watcher.label,
    watcher.detail,
    watcher.cron,
    watcher.schedule,
    watcher.recurring ? 1 : 0,
    watcher.state,
    watcher.nextDueAt,
    watcher.expiresAt,
    now,
  )
  return parseWatcher(
    db
      .prepare(`SELECT ${COLUMNS} FROM watchers WHERE task_id = ? AND tool_use_id = ?`)
      .get(watcher.taskId, watcher.toolUseId),
  )
}

/** Changes a watcher. Answers with it as it now is, or undefined when there's no such watcher. */
export function updateWatcher(db: Database, id: string, change: WatcherChange): StoredWatcher | undefined {
  const sets: string[] = []
  const values: (string | number | null)[] = []
  const set = (column: string, value: string | number | null): void => {
    sets.push(`${column} = ?`)
    values.push(value)
  }
  if (change.sdkId !== undefined) set('sdk_id', change.sdkId)
  if (change.state !== undefined) set('state', change.state)
  if (change.wakes !== undefined) set('wakes', change.wakes)
  if (change.lastWokeAt !== undefined) set('last_woke_at', change.lastWokeAt)
  if (change.lastOutput !== undefined) set('last_output', change.lastOutput)
  if (change.nextDueAt !== undefined) set('next_due_at', change.nextDueAt)
  if (change.expiresAt !== undefined) set('expires_at', change.expiresAt)
  if (change.outcome !== undefined) set('outcome', change.outcome)
  if (change.stoppedByYou !== undefined) set('stopped_by_you', change.stoppedByYou ? 1 : 0)
  if (change.endedAt !== undefined) set('ended_at', change.endedAt)
  if (sets.length > 0) db.prepare(`UPDATE watchers SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
  return getWatcher(db, id)
}

export function getWatcher(db: Database, id: string): StoredWatcher | undefined {
  const raw: unknown = db.prepare(`SELECT ${COLUMNS} FROM watchers WHERE id = ?`).get(id)
  return raw === undefined ? undefined : parseWatcher(raw)
}

/** A task's watchers, in the order they started. */
export function listWatchers(db: Database, taskId: string): StoredWatcher[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM watchers WHERE task_id = ? ORDER BY started_at, rowid`)
    .all(taskId)
    .map(parseWatcher)
}

/** Every task's live watchers (running, scheduled or suspended), in the order they started. */
export function listLiveWatchers(db: Database): StoredWatcher[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM watchers WHERE state IN ${LIVE} ORDER BY started_at, rowid`)
    .all()
    .map(parseWatcher)
}

/** A task's watcher of one of `kinds` that the SDK knows by `sdkId`, if there is one. */
export function findWatcherBySdkId(
  db: Database,
  taskId: string,
  sdkId: string,
  kinds: readonly WatcherKind[],
): StoredWatcher | undefined {
  return listWatchers(db, taskId).find((watcher) => watcher.sdkId === sdkId && kinds.includes(watcher.kind))
}
