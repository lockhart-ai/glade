/**
 * The todo hub in main (P16, #491; `src/shared/todoHub.ts`): reading what a task produced grouped by todo, giving its
 * children the short ids the agent names them by, filing them, and remembering each todo's panel. What the agent's own
 * two tools do with them (`list_children`, `file_children`) is in `./agent-children`.
 *
 * A todo holds produced work only (#535): files, links and commits. A subagent is filed too, as plumbing (its todo is
 * what its commits follow), and never shown under the todo; a watcher isn't filed, read or named here at all.
 *
 * It's on for every task (#501): a task from before the hub has no filings, so everything it produced reads as loose
 * ("Not under a todo") until its agent files it.
 */
import type { Database } from 'better-sqlite3'
import { EventType, type TodoHubGetResponse } from '../../shared/bridge'
import type { EpochMs } from '../../shared/domain'
import { SUBAGENT_TOOL_NAMES } from '../../shared/subagents'
import {
  FilingSource,
  groupChildren,
  refKey,
  type ChildId,
  type ChildRef,
  type Filing,
  type IdentifiedChild,
  type NewFiling,
  type TaskChildren,
  type TodoPanel,
} from '../../shared/todoHub'
import type { Emit } from '../bridge/events'
import { getAgentTab, setAgentTab } from '../db/repositories/agent-tabs'
import { listArtifacts } from '../db/repositories/artifacts'
import { listFilings, putFilings, removeFilings } from '../db/repositories/child-filings'
import { assignChildIds, findChildById, isWatcherId } from '../db/repositories/child-ids'
import { settleOwedFilings } from '../db/repositories/owed-filings'
import { listTaskCommits } from '../db/repositories/task-commits'
import { listTodoPanels, setTodoPanel } from '../db/repositories/todo-panels'
import { listToolCallsNamed } from '../db/repositories/tool-events'
import { requireTask } from '../tasks/service'
import { todoListFor } from '../todos/todos'

/**
 * Everything of a task the hub groups: its todo list, artifacts, subagents (every `Agent` call, nested ones included),
 * commits and filings.
 */
export function taskChildren(db: Database, taskId: string): TaskChildren {
  return {
    todos: todoListFor(db, taskId)?.items ?? [],
    artifacts: listArtifacts(db, taskId),
    subagents: listToolCallsNamed(db, taskId, SUBAGENT_TOOL_NAMES),
    commits: listTaskCommits(db, taskId),
    filings: listFilings(db, taskId),
  }
}

/**
 * A task's todo hub (`todoHub.get`): what it produced grouped by todo, its filings (its subagents' todos among them),
 * and its todos' panels. Fails with `not_found` when there's no such task.
 */
export function readTodoHub(db: Database, taskId: string): TodoHubGetResponse {
  requireTask(db, taskId)
  const children = taskChildren(db, taskId)
  return { children: groupChildren(children), filings: children.filings, panels: listTodoPanels(db, taskId) }
}

/**
 * Remembers how you left a todo's panel (`todoHub.setPanel`). The todo needn't be in the list (any more): its id is
 * never used again. Fails with `not_found` when there's no such task.
 */
export function rememberTodoPanel(db: Database, panel: TodoPanel): void {
  requireTask(db, panel.taskId)
  setTodoPanel(db, panel)
}

/**
 * Which agent's tab a task's Agents tab was left on (#536), as its history carries it: a subagent's `Agent` call's
 * `tool_use` id, or null for Main, which is also where a task that never picked one is.
 */
export function agentTabOf(db: Database, taskId: string): string | null {
  return getAgentTab(db, taskId)
}

/**
 * Remembers which agent's tab a task's Agents tab is on (`agents.setTab`): null is Main. The subagent needn't be in
 * the task's log. Fails with `not_found` when there's no such task.
 */
export function rememberAgentTab(db: Database, taskId: string, agentId: string | null): void {
  requireTask(db, taskId)
  setAgentTab(db, taskId, agentId)
}

/**
 * The short ids of some of a task's children (`c1`, `c2`, …), in the order given: what Glade names them by to the
 * agent, and the agent files and moves them by. A child Glade hasn't named before gets the task's next number, there
 * and then; one it has keeps its id, for the life of the task, and no other child ever gets it (`ChildId`). For every
 * child of a task at once, give it `childrenOf(taskChildren(…))`.
 */
export function identifyChildren(db: Database, taskId: string, children: readonly ChildRef[]): IdentifiedChild[] {
  if (children.length === 0) return []
  return assignChildIds(db, taskId, children)
}

/**
 * The child of a task a short id names, as the agent gives one back. Undefined for an id Glade never gave a child of
 * the task, and for text that isn't an id.
 */
export function childWithId(db: Database, taskId: string, id: ChildId): ChildRef | undefined {
  return findChildById(db, taskId, id)
}

/**
 * Whether a short id was a watcher's, from when watchers had ids (before #535): it names no child (`childWithId`), and
 * is told apart so the agent can be told that watchers aren't filed.
 */
export function wasWatcherId(db: Database, taskId: string, id: ChildId): boolean {
  return isWatcherId(db, taskId, id)
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
 * nothing written or sent, when there's nothing to file.
 */
export function fileChildren(
  { db, emit }: FilingContext,
  taskId: string,
  filings: readonly NewFiling[],
  now: EpochMs = Date.now(),
): Filing[] {
  if (filings.length === 0) return []
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
 * one (`filings.changed`). Answers with those; none, with nothing written or sent, when none of them was filed.
 */
export function unfileChildren({ db, emit }: FilingContext, taskId: string, children: readonly ChildRef[]): ChildRef[] {
  if (children.length === 0) return []
  const removed = removeFilings(db, taskId, children)
  if (removed.length > 0) emit({ type: EventType.FilingsChanged, taskId, filed: [], removed })
  return removed
}

/**
 * A child of a task is named by another key from now on (an artifact pointed at another file or page): its filing goes
 * with it, under the same todo, as it was filed, and the windows hear both (`filings.changed`). Nothing is written or
 * sent for a child that had no filing, or when the key is the one it had.
 */
export function refileChild({ db, emit }: FilingContext, taskId: string, from: ChildRef, to: ChildRef): void {
  if (refKey(from) === refKey(to)) return
  const had = listFilings(db, taskId).find((filing) => refKey(filing) === refKey(from))
  if (had === undefined) return
  const filed = db.transaction(() => {
    removeFilings(db, taskId, [from])
    return putFilings(db, taskId, [{ kind: to.kind, key: to.key, todoId: had.todoId, source: had.source }], had.filedAt)
  })()
  emit({ type: EventType.FilingsChanged, taskId, filed, removed: [{ kind: from.kind, key: from.key }] })
}
