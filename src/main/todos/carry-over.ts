/**
 * Replays Claude Code's own todo tool calls (`TaskCreate`, `TaskUpdate`, `TodoWrite`) into Glade's own todos table
 * (#609). Two callers need this: the one-time migration that carries every task's list over once Glade starts
 * keeping it in SQLite, and an imported Claude Code session, whose `TaskCreate` history it reads the same way, at
 * import time.
 *
 * Deliberately apart from `./todos`, the derivation the live Todos tab reads today: that module (and the shared list
 * folder and the retired-todos table it leans on) is on its way out once every task has carried over, but this replay
 * is not — an import always needs it — so it carries nothing of theirs: it reads only the tool log, and takes what
 * it should leave out of a carry-over (a retired id) as a plain argument, not a table it queries itself.
 *
 * `completedAt` aside, this only has to match what the Todos tab shows *today*, not every rule `./todos` enforces:
 * a stranded todo (one a restart left the agent's own list without) carries over as an ordinary one, since nothing
 * is ever stranded once Glade owns the list. One rule does change, on purpose: today's tab shows `activeForm` as a
 * note only while a todo is in progress; once Glade owns the list a note is stored and shown in any state but done
 * (an old spinner line would read wrongly once the todo is finished), so the replay carries it for a not-started
 * todo too, not only a doing one.
 */
import type { Database } from 'better-sqlite3'
import { TodoState, ToolCallState, type EpochMs, type ToolCallEvent } from '../../shared/domain'
import { listToolCallsNamed } from '../db/repositories/tool-events'
import { getTodoCounter, putTodos, seedTodoCounterAtLeast, type NewTodo } from '../db/repositories/glade-todos'
import {
  ClaudeTodoStatus,
  createdTaskId,
  DELETED_STATUS,
  taskCreateInput,
  taskUpdateInput,
  todoWriteInput,
} from './schema'

/** Claude Code's own todo tools, by name (kept here, not imported from `./todos`: see the module comment). */
const LEGACY_TODO_TOOLS = ['TodoWrite', 'TaskCreate', 'TaskUpdate'] as const

type LegacyTodoTool = (typeof LEGACY_TODO_TOOLS)[number]

/** `name` as one of `LEGACY_TODO_TOOLS`, typed so `apply`'s switch is exhaustive with no dead default; null otherwise. */
function legacyToolName(name: string): LegacyTodoTool | null {
  return (LEGACY_TODO_TOOLS as readonly string[]).includes(name) ? (name as LegacyTodoTool) : null
}

const STATES: Readonly<Record<ClaudeTodoStatus, TodoState>> = {
  [ClaudeTodoStatus.Pending]: TodoState.Todo,
  [ClaudeTodoStatus.InProgress]: TodoState.Doing,
  [ClaudeTodoStatus.Completed]: TodoState.Done,
}

/** An item as the replay holds it while it works through the calls: Claude Code's own words, until the end. */
interface LegacyItem {
  readonly id: string | null
  readonly text: string
  readonly status: ClaudeTodoStatus
  readonly activeForm: string | undefined
  readonly completedAt: EpochMs | null
}

/** A todo as the replay answers it: Glade's own words, ready to write (`NewTodo`), with no id yet for a legacy one. */
export interface ReplayedTodo {
  readonly id: string | null
  readonly text: string
  readonly note: string | null
  readonly state: TodoState
  readonly completedAt: EpochMs | null
}

/** What replaying a task's whole tool-log history of todo calls gives. */
export interface ReplayedTodos {
  /** What the list holds now, in order (the order each was first created in: an update never reorders it). */
  readonly items: readonly ReplayedTodo[]
  /**
   * The highest numbered id any `TaskCreate` in the log was ever given, whether or not it (or the todo that took its
   * number over) is still in `items`: a carry-over's counter must start past this, not just past what's left, or a
   * deleted or taken-over number could be given out again. Null when no `TaskCreate` ever ran.
   */
  readonly highestIdEverGiven: number | null
}

function completedAt(status: ClaudeTodoStatus, was: LegacyItem | undefined, at: EpochMs): EpochMs | null {
  if (status !== ClaudeTodoStatus.Completed) return null
  return was?.status === ClaudeTodoStatus.Completed ? was.completedAt : at
}

/** `TodoWrite`'s items have no id, so one completed before is the one with the same text, each matched once. */
function previouslyCompleted(items: readonly LegacyItem[]): (text: string) => LegacyItem | undefined {
  const byText = new Map<string, LegacyItem[]>()
  for (const item of items) {
    if (item.status !== ClaudeTodoStatus.Completed) continue
    byText.set(item.text, [...(byText.get(item.text) ?? []), item])
  }
  return (text) => byText.get(text)?.shift()
}

/**
 * The todo tool a call can change the list with: a finished, successful call of the main agent's, to one of
 * `LEGACY_TODO_TOOLS`. Null for anything else (a subagent's, one still running or failed, or another tool).
 */
function changesTodos(call: ToolCallEvent): LegacyTodoTool | null {
  if (call.parentToolUseId !== null || call.state !== ToolCallState.Done) return null
  return legacyToolName(call.name)
}

/** The numeric id a finished `TaskCreate`'s result gave, if it parses as one; undefined otherwise. */
function numericId(output: string | null): number | undefined {
  const id = createdTaskId(output ?? '')
  const parsed = id === undefined ? Number.NaN : Number.parseInt(id, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** The list, and the highest id ever given, after one call; unchanged when the call's input doesn't parse. */
function apply(
  items: readonly LegacyItem[],
  highest: number | null,
  toolName: LegacyTodoTool,
  call: ToolCallEvent,
): { items: readonly LegacyItem[]; highest: number | null } {
  switch (toolName) {
    case 'TodoWrite': {
      const input = todoWriteInput.safeParse(call.input)
      if (!input.success) return { items, highest }
      const before = previouslyCompleted(items)
      const next = input.data.todos.map(({ content, status, activeForm }): LegacyItem => ({
        id: null,
        text: content,
        status,
        activeForm,
        completedAt: completedAt(
          status,
          status === ClaudeTodoStatus.Completed ? before(content) : undefined,
          call.createdAt,
        ),
      }))
      return { items: next, highest }
    }
    case 'TaskCreate': {
      const input = taskCreateInput.safeParse(call.input)
      if (!input.success) return { items, highest }
      const id = numericId(call.output)
      const nextHighest = id === undefined ? highest : Math.max(highest ?? 0, id)
      const idText = id === undefined ? null : String(id)
      const item: LegacyItem = {
        id: idText,
        text: input.data.subject,
        status: ClaudeTodoStatus.Pending,
        activeForm: input.data.activeForm,
        completedAt: null,
      }
      return {
        items: [...items.filter((existing) => idText === null || existing.id !== idText), item],
        highest: nextHighest,
      }
    }
    case 'TaskUpdate': {
      const input = taskUpdateInput.safeParse(call.input)
      if (!input.success) return { items, highest }
      const { taskId, status, subject, activeForm } = input.data
      if (status === DELETED_STATUS) return { items: items.filter((item) => item.id !== taskId), highest }
      const next = items.map((item) =>
        item.id === taskId
          ? {
              ...item,
              text: subject ?? item.text,
              activeForm: activeForm ?? item.activeForm,
              status: status ?? item.status,
              completedAt: completedAt(status ?? item.status, item, call.createdAt),
            }
          : item,
      )
      return { items: next, highest }
    }
  }
}

/**
 * An item in Glade's own words: a note in any state but done, not only while it's doing, as the module comment
 * above explains — an old spinner line is dropped once the todo is finished, but kept for one not yet started.
 */
function toReplayedTodo({ id, text, status, activeForm, completedAt: at }: LegacyItem): ReplayedTodo {
  const state = STATES[status]
  const note = state !== TodoState.Done && activeForm !== undefined && activeForm.trim() !== '' ? activeForm : null
  return { id, text, note, state, completedAt: at }
}

/**
 * Replays a task's `TaskCreate`/`TaskUpdate`/`TodoWrite` calls, in the order they ran, into the list they leave and
 * the highest id any of them was ever given. Calls of any other tool are ignored; a subagent's, or one that failed or
 * is still running, changes nothing (`changesTodos`).
 */
export function replayLegacyTodos(calls: readonly ToolCallEvent[]): ReplayedTodos {
  let items: readonly LegacyItem[] = []
  let highest: number | null = null
  for (const call of calls) {
    const toolName = changesTodos(call)
    if (toolName === null) continue
    const next = apply(items, highest, toolName, call)
    items = next.items
    highest = next.highest
  }
  return { items: items.map(toReplayedTodo), highestIdEverGiven: highest }
}

/**
 * Carries one task's todos over into its own table (#609): reads its tool log, replays it, leaves out any id in
 * `retiredIds` (a todo the agent closed with `close_todo` before Glade owned the list — nothing an import ever has),
 * gives a fresh id to any item that came from `TodoWrite` and so has none, and seeds the task's counter past the
 * highest id ever given, closed or taken-over ones included, so none of them is ever given out again.
 *
 * Idempotent: a task that already has a counter (this ran before, or it has already made a todo the new way) is left
 * exactly as it is, and nothing is read or written for it.
 */
export function carryOverTodos(db: Database, taskId: string, retiredIds: ReadonlySet<string> = new Set()): void {
  if (getTodoCounter(db, taskId) !== null) return
  const calls = listToolCallsNamed(db, taskId, LEGACY_TODO_TOOLS)
  const { items, highestIdEverGiven } = replayLegacyTodos(calls)
  const kept = items.filter(({ id }) => id === null || !retiredIds.has(id))
  let next = (highestIdEverGiven ?? 0) + 1
  const rows: NewTodo[] = kept.map((item) => {
    if (item.id !== null) return { ...item, id: item.id }
    const id = String(next)
    next += 1
    return { ...item, id }
  })
  db.transaction(() => {
    putTodos(db, taskId, rows)
    seedTodoCounterAtLeast(db, taskId, next)
  })()
}
