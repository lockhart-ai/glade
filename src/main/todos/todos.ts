/**
 * The Todos tab's list, worked out from the task's tool log. Glade doesn't give the agent a todo tool of its own: it maps
 * the ones Claude Code already has, which the model uses without being asked.
 *
 * - `TaskCreate` and `TaskUpdate` are what the bundled Claude Code (2.1) gives the agent, once Glade turns them on
 *   (`SESSION_ENV` in `../agent/sdk-backend`): each call adds or changes one item, by the id `TaskCreate`'s result
 *   gave it.
 * - `TodoWrite` is the older tool, still there when Claude Code's task tools are turned off
 *   (`CLAUDE_CODE_ENABLE_TASKS=false`): each call replaces the whole list.
 *
 * Only the main agent's calls that succeeded count: a subagent's are its own business, and a call that failed changed
 * nothing. `pending`, `in_progress` and `completed` map to todo, doing and done, and a doing item's `activeForm` ("Copying
 * the files") is its note. Nothing maps to waiting yet. The tool calls stay in the tool log like any others.
 *
 * A done item keeps when it was finished (#282): the time of the call that marked it done, i.e. the `TaskUpdate` that
 * set it completed, or the first of the `TodoWrite`s that has kept it completed since. An item that goes back from
 * completed loses it. Since it's worked out from the stored tool log, it survives a relaunch like the rest of the list.
 */
import type { Database } from 'better-sqlite3'
import {
  TodoState,
  ToolCallState,
  type EpochMs,
  type Task,
  type Todo,
  type TodoList,
  type ToolCallEvent,
} from '../../shared/domain'
import { sameTodoSummary, summarizeTodos } from '../../shared/todoSummary'
import { getTask, listStaleTodoTaskIds, setTaskTodos } from '../db/repositories/tasks'
import { listToolCallsNamed } from '../db/repositories/tool-events'
import {
  ClaudeTodoStatus,
  createdTaskId,
  DELETED_STATUS,
  taskCreateInput,
  taskUpdateInput,
  todoWriteInput,
  type TaskUpdateInput,
} from './schema'

/** Claude Code's todo tools, by name. */
export enum TodoTool {
  TodoWrite = 'TodoWrite',
  TaskCreate = 'TaskCreate',
  TaskUpdate = 'TaskUpdate',
}

export const TODO_TOOLS: readonly string[] = Object.values(TodoTool)

const STATES: Readonly<Record<ClaudeTodoStatus, TodoState>> = {
  [ClaudeTodoStatus.Pending]: TodoState.Todo,
  [ClaudeTodoStatus.InProgress]: TodoState.Doing,
  [ClaudeTodoStatus.Completed]: TodoState.Done,
}

/**
 * An item as the tools know it: its id (`TaskCreate`'s; null for `TodoWrite`'s), text, status and active form, and when
 * the call that marked it completed was made (null while it isn't).
 */
interface Item {
  readonly id: string | null
  readonly text: string
  readonly status: ClaudeTodoStatus
  readonly activeForm: string | undefined
  readonly completedAt: EpochMs | null
}

/** Whether a call can change the todo list: a finished, successful call of the main agent to a todo tool. */
export function changesTodos(call: ToolCallEvent): boolean {
  return call.parentToolUseId === null && call.state === ToolCallState.Done && TODO_TOOLS.includes(call.name)
}

function toTodo({ text, status, activeForm, completedAt }: Item): Todo {
  const state = STATES[status]
  const note = state === TodoState.Doing && activeForm !== undefined && activeForm.trim() !== '' ? activeForm : null
  return { text, state, note, completedAt }
}

/**
 * When an item with this status was finished, as of a call made at `at`: still `was` for one that was already completed,
 * `at` for one the call completes, and null for one that isn't completed.
 */
function completedAt(status: ClaudeTodoStatus, was: Item | undefined, at: EpochMs): EpochMs | null {
  if (status !== ClaudeTodoStatus.Completed) return null
  return was?.status === ClaudeTodoStatus.Completed ? was.completedAt : at
}

function updated(item: Item, { subject, activeForm, status }: TaskUpdateInput, at: EpochMs): Item {
  const next = status === undefined || status === DELETED_STATUS ? item.status : status
  return {
    ...item,
    text: subject ?? item.text,
    activeForm: activeForm ?? item.activeForm,
    status: next,
    completedAt: completedAt(next, item, at),
  }
}

/**
 * `TodoWrite`'s items have no ids, so an item completed in the list before is the one with the same text. Each earlier
 * item matches one new item at most, in order, so two items with the same text keep their own times.
 */
function previouslyCompleted(items: readonly Item[]): (text: string) => Item | undefined {
  const byText = new Map<string, Item[]>()
  for (const item of items) {
    if (item.status !== ClaudeTodoStatus.Completed) continue
    byText.set(item.text, [...(byText.get(item.text) ?? []), item])
  }
  return (text) => byText.get(text)?.shift()
}

/** The list after one call; null when the call's input doesn't parse, so it changed nothing. */
function apply(items: readonly Item[], call: ToolCallEvent): readonly Item[] | null {
  switch (call.name as TodoTool) {
    case TodoTool.TodoWrite: {
      const input = todoWriteInput.safeParse(call.input)
      if (!input.success) return null
      const before = previouslyCompleted(items)
      return input.data.todos.map(({ content, status, activeForm }) => ({
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
    }
    case TodoTool.TaskCreate: {
      const input = taskCreateInput.safeParse(call.input)
      if (!input.success) return null
      const id = createdTaskId(call.output ?? '') ?? null
      const item: Item = {
        id,
        text: input.data.subject,
        status: ClaudeTodoStatus.Pending,
        activeForm: input.data.activeForm,
        completedAt: null,
      }
      return [...items.filter((existing) => id === null || existing.id !== id), item]
    }
    case TodoTool.TaskUpdate: {
      const input = taskUpdateInput.safeParse(call.input)
      if (!input.success) return null
      const change = input.data
      if (change.status === DELETED_STATUS) return items.filter(({ id }) => id !== change.taskId)
      return items.map((item) => (item.id === change.taskId ? updated(item, change, call.createdAt) : item))
    }
  }
}

/**
 * The todo list the calls leave, in the order they were made; null when none of them changed it, i.e. the agent has kept
 * no list.
 */
export function deriveTodoList(calls: readonly ToolCallEvent[]): TodoList | null {
  let items: readonly Item[] = []
  let updatedAt: EpochMs | null = null
  for (const call of calls) {
    const next = changesTodos(call) ? apply(items, call) : null
    if (next === null) continue
    items = next
    updatedAt = call.createdAt
  }
  return updatedAt === null ? null : { items: items.map(toTodo), updatedAt }
}

/** A task's todo list, as its tool log leaves it. */
export function todoListFor(db: Database, taskId: string): TodoList | null {
  return deriveTodoList(listToolCallsNamed(db, taskId, TODO_TOOLS))
}

/** A task's todo list worked out again (`refreshTodos`). */
export interface RefreshedTodos {
  /** The list, for the Todos tab. */
  readonly list: TodoList | null
  /** The task with its new todo summary, when the summary changed, to tell the windows; null when it didn't. */
  readonly changed: Task | null
}

/**
 * Works a task's todo list out from its tool log and keeps its summary on the task, for its row in the task list. Run
 * whenever a call that can change the list is logged or finishes, so the row keeps up with the Todos tab.
 */
export function refreshTodos(db: Database, taskId: string): RefreshedTodos {
  const list = todoListFor(db, taskId)
  const todos = summarizeTodos(list)
  const task = getTask(db, taskId)
  if (task === undefined) return { list, changed: null }
  setTaskTodos(db, taskId, todos)
  return { list, changed: sameTodoSummary(task.todos, todos) ? null : { ...task, todos } }
}

/**
 * Works out the todo summaries marked stale: the tasks that kept a todo list before Glade kept summaries (migration 29).
 * Run once main has the database, before the window lists any task. Answers how many it worked out.
 */
export function refreshStaleTodos(db: Database): number {
  return db.transaction(() => {
    const ids = listStaleTodoTaskIds(db)
    for (const id of ids) refreshTodos(db, id)
    return ids.length
  })()
}
