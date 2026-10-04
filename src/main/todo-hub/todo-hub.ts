/**
 * The todo hub in main (P16, #491; `src/shared/todoHub.ts`): reading what a task produced grouped by todo, giving its
 * children the short ids the agent names them by, filing them, and remembering each todo's panel. What the agent's own
 * two tools do with them (`list_children`, `file_children`) is in `./agent-children`.
 *
 * A todo holds produced work only (#535): files, links and commits. A subagent is filed too, as plumbing (its todo is
 * what its commits follow), and never shown under the todo; a watcher isn't filed, read or named here at all.
 *
 * **Built dark.** Everything here is behind the hidden setting `todoHubEnabled`, off until the phase's last issue
 * (#501), and each entry point checks it itself: with it off, a read or a panel change is refused, a filing changes
 * nothing and sends nothing, no child gets or has an id, and the hub's three tables (`child_ids`, `child_filings`,
 * `todo_panels`) are never touched.
 */
import type { Database } from 'better-sqlite3'
import { BridgeErrorCode, EventType, type TodoHubGetResponse } from '../../shared/bridge'
import type { EpochMs } from '../../shared/domain'
import { SUBAGENT_TOOL_NAMES } from '../../shared/subagents'
import {
  FilingSource,
  groupChildren,
  refKey,
  TODO_HUB_OFF,
  type ChildId,
  type ChildRef,
  type Filing,
  type IdentifiedChild,
  type NewFiling,
  type TaskChildren,
  type TodoPanel,
} from '../../shared/todoHub'
import { CommandFailure } from '../bridge/errors'
import type { Emit } from '../bridge/events'
import { listArtifacts } from '../db/repositories/artifacts'
import { listFilings, putFilings, removeFilings } from '../db/repositories/child-filings'
import { assignChildIds, findChildById, isWatcherId } from '../db/repositories/child-ids'
import { settleOwedFilings } from '../db/repositories/owed-filings'
import { getSettings } from '../db/repositories/settings'
import { listTaskCommits } from '../db/repositories/task-commits'
import { listTodoPanels, setTodoPanel } from '../db/repositories/todo-panels'
import { listToolCallsNamed } from '../db/repositories/tool-events'
import { requireTask } from '../tasks/service'
import { todoListFor } from '../todos/todos'

/** Whether the todo hub is on: the hidden `todoHubEnabled` setting. */
export function isTodoHubEnabled(db: Database): boolean {
  return getSettings(db).todoHubEnabled
}

/** Refuses while the hub is off: `invalid_transition`, saying so (`TODO_HUB_OFF`). */
export function requireTodoHub(db: Database): void {
  if (!isTodoHubEnabled(db)) throw new CommandFailure(BridgeErrorCode.InvalidTransition, TODO_HUB_OFF)
}

/**
 * Everything of a task the hub groups: its todo list, artifacts, subagents (every `Agent` call, nested ones included),
 * commits and filings. While the hub is off, it has no filings.
 */
export function taskChildren(db: Database, taskId: string): TaskChildren {
  return {
    todos: todoListFor(db, taskId)?.items ?? [],
    artifacts: listArtifacts(db, taskId),
    subagents: listToolCallsNamed(db, taskId, SUBAGENT_TOOL_NAMES),
    commits: listTaskCommits(db, taskId),
    filings: isTodoHubEnabled(db) ? listFilings(db, taskId) : [],
  }
}

/**
 * A task's todo hub (`todoHub.get`): what it produced grouped by todo, its filings (its subagents' todos among them),
 * and its todos' panels. Fails with `invalid_transition` while the hub is off, and `not_found` when there's no such task.
 */
export function readTodoHub(db: Database, taskId: string): TodoHubGetResponse {
  requireTodoHub(db)
  requireTask(db, taskId)
  const children = taskChildren(db, taskId)
  return { children: groupChildren(children), filings: children.filings, panels: listTodoPanels(db, taskId) }
}

/**
 * Remembers how you left a todo's panel (`todoHub.setPanel`). The todo needn't be in the list (any more): its id is
 * never used again. Fails with `invalid_transition` while the hub is off, and `not_found` when there's no such task.
 */
export function rememberTodoPanel(db: Database, panel: TodoPanel): void {
  requireTodoHub(db)
  requireTask(db, panel.taskId)
  setTodoPanel(db, panel)
}

/**
 * The short ids of some of a task's children (`c1`, `c2`, …), in the order given: what Glade names them by to the
 * agent, and the agent files and moves them by. A child Glade hasn't named before gets the task's next number, there
 * and then; one it has keeps its id, for the life of the task, and no other child ever gets it (`ChildId`). For every
 * child of a task at once, give it `childrenOf(taskChildren(…))`. None, with nothing written, while the hub is off.
 */
export function identifyChildren(db: Database, taskId: string, children: readonly ChildRef[]): IdentifiedChild[] {
  if (children.length === 0 || !isTodoHubEnabled(db)) return []
  return assignChildIds(db, taskId, children)
}

/**
 * The child of a task a short id names, as the agent gives one back. Undefined for an id Glade never gave a child of
 * the task, for text that isn't an id, and while the hub is off.
 */
export function childWithId(db: Database, taskId: string, id: ChildId): ChildRef | undefined {
  return isTodoHubEnabled(db) ? findChildById(db, taskId, id) : undefined
}

/**
 * Whether a short id was a watcher's, from when watchers had ids (before #535): it names no child (`childWithId`), and
 * is told apart so the agent can be told that watchers aren't filed. Never while the hub is off.
 */
export function wasWatcherId(db: Database, taskId: string, id: ChildId): boolean {
  return isTodoHubEnabled(db) && isWatcherId(db, taskId, id)
}

/** What filing needs: the database, and the windows to tell. */
export interface FilingContext {
  readonly db: Database
  readonly emit: Emit
}

/**
 * Files children of a task under todos, replacing any filing they had, and tells the windows what changed
 * (`filings.changed`, with these filings alone). All of them or none. It doesn't check that a todo is in the task's
 * list: one that isn't shows its children under "Not under a todo". A child filed on its own (any filing but an
 * inherited one) is no longer one its agent owes a filing for (`./filing`). Answers with the filings made; none, with
 * nothing written or sent, while the hub is off or there's nothing to file.
 */
export function fileChildren(
  { db, emit }: FilingContext,
  taskId: string,
  filings: readonly NewFiling[],
  now: EpochMs = Date.now(),
): Filing[] {
  if (filings.length === 0 || !isTodoHubEnabled(db)) return []
  const filed = db.transaction(() => {
    settleOwedFilings(
      db,
      taskId,
      filings.filter(({ source }) => source !== FilingSource.Inherited),
    )
    return putFilings(db, taskId, filings, now)
  })()
  emit({ type: EventType.FilingsChanged, taskId, filed, removed: [] })
  return filed
}

/**
 * Takes the filings of some of a task's children away (a removed artifact's, say), and tells the windows which had
 * one (`filings.changed`). Answers with those; none, with nothing written or sent, while the hub is off or none of
 * them was filed.
 */
export function unfileChildren({ db, emit }: FilingContext, taskId: string, children: readonly ChildRef[]): ChildRef[] {
  if (children.length === 0 || !isTodoHubEnabled(db)) return []
  const removed = removeFilings(db, taskId, children)
  if (removed.length > 0) emit({ type: EventType.FilingsChanged, taskId, filed: [], removed })
  return removed
}

/**
 * A child of a task is named by another key from now on (an artifact pointed at another file or page): its filing goes
 * with it, under the same todo, as it was filed, and the windows hear both (`filings.changed`). Nothing is written or
 * sent while the hub is off, for a child that had no filing, or when the key is the one it had.
 */
export function refileChild({ db, emit }: FilingContext, taskId: string, from: ChildRef, to: ChildRef): void {
  if (refKey(from) === refKey(to) || !isTodoHubEnabled(db)) return
  const had = listFilings(db, taskId).find((filing) => refKey(filing) === refKey(from))
  if (had === undefined) return
  const filed = db.transaction(() => {
    removeFilings(db, taskId, [from])
    return putFilings(db, taskId, [{ kind: to.kind, key: to.key, todoId: had.todoId, source: had.source }], had.filedAt)
  })()
  emit({ type: EventType.FilingsChanged, taskId, filed, removed: [{ kind: from.kind, key: from.key }] })
}
