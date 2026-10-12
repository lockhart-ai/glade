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
 * Each item keeps the id `TaskCreate` gave it (`Todo.id`, the `N` of `Task #N`), which the Todos tab keys its row on and
 * the todo hub files children under (P16, `src/shared/todoHub.ts`). A `TodoWrite` item has none.
 *
 * Only the main agent's calls that succeeded count: a subagent's are its own business, and a call that failed changed
 * nothing. `pending`, `in_progress` and `completed` map to todo, doing and done, and a doing item's `activeForm` ("Copying
 * the files") is its note. Nothing maps to waiting yet. The tool calls stay in the tool log like any others.
 *
 * A done item keeps when it was finished (#282): the time of the call that marked it done, i.e. the `TaskUpdate` that
 * set it completed, or the first of the `TodoWrite`s that has kept it completed since. An item that goes back from
 * completed loses it. Since it's worked out from the stored tool log, it survives a relaunch like the rest of the list.
 *
 * A numbered item the task's agent no longer holds in its live list — one a restart of the session stranded (#593) —
 * is marked `stranded` (`liveTodos`, from the shared list folder `../openrouter/task-list` keeps), and one the agent
 * has closed with `close_todo` is left out (`todoListFor`, the `retired_todos` table): out of the tab, the summaries,
 * `list_children` and the "Your todos:" line, its history staying in the tool log.
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
import { liveTodoIds } from '../openrouter/task-list'
import { listRetiredTodoIds } from '../db/repositories/retired-todos'
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

function toTodo({ id, text, status, activeForm, completedAt }: Item): Todo {
  const state = STATES[status]
  const note = state === TodoState.Doing && activeForm !== undefined && activeForm.trim() !== '' ? activeForm : null
  return { id, text, state, note, completedAt }
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

/** The list a replay of the calls leaves, and when the last call that changed it was made. */
function deriveItems(calls: readonly ToolCallEvent[]): { items: readonly Item[]; updatedAt: EpochMs | null } {
  let items: readonly Item[] = []
  let updatedAt: EpochMs | null = null
  for (const call of calls) {
    const next = changesTodos(call) ? apply(items, call) : null
    if (next === null) continue
    items = next
    updatedAt = call.createdAt
  }
  return { items, updatedAt }
}

/**
 * The todo list the calls leave, in the order they were made; null when none of them changed it, i.e. the agent has kept
 * no list.
 */
export function deriveTodoList(calls: readonly ToolCallEvent[]): TodoList | null {
  const { items, updatedAt } = deriveItems(calls)
  return updatedAt === null ? null : { items: items.map(toTodo), updatedAt }
}

/**
 * The highest todo id Glade already holds for a task, as a number; null when it holds no numbered todo. One the agent
 * has closed is out of the list (`todoListFor`) and so not counted — which doesn't matter, since a list is only ever
 * seeded before any todo of the task can be closed.
 */
export function highestTodoId(db: Database, taskId: string): number | null {
  const ids = (todoListFor(db, taskId)?.items ?? [])
    .map(({ id }) => (id === null ? Number.NaN : Number.parseInt(id, 10)))
    .filter((id) => Number.isFinite(id))
  return ids.length === 0 ? null : Math.max(...ids)
}

/** What a `TaskCreate` took over: the todo id, and the subject the todo that held it had. */
export interface TakenTodo {
  readonly todoId: string
  readonly subject: string
}

/**
 * Whether a finished `TaskCreate` took a todo id a different subject already held, with that subject (#593): the new
 * todo must not inherit what was filed under the old one. The same subject is the agent recreating its own todo, which
 * keeps them; a call that isn't a `TaskCreate`, or whose id can't be read from its result, took over nothing.
 */
export function takenOverTodo(calls: readonly ToolCallEvent[], call: ToolCallEvent): TakenTodo | null {
  const input = taskCreateInput.safeParse(call.input)
  const todoId = input.success ? createdTaskId(call.output ?? '') : undefined
  if (!input.success || todoId === undefined) return null
  const previous = deriveItems(calls.filter((other) => other.toolUseId !== call.toolUseId)).items.find(
    ({ id }) => id === todoId,
  )
  if (previous === undefined || previous.text === input.data.subject) return null
  return { todoId, subject: previous.text }
}

/**
 * Whether the finished `TaskCreate` call took a todo id a different subject already held, with that subject (#593).
 * The call reads its own list from the tool log, so the caller needs only the call.
 */
export function takenOverTodoLogged(db: Database, taskId: string, call: ToolCallEvent): TakenTodo | null {
  return takenOverTodo(listToolCallsNamed(db, taskId, TODO_TOOLS), call)
}

/** A task's todo list, as its tool log leaves it, without the todos its agent has closed (`close_todo`, #593). */
export function todoListFor(db: Database, taskId: string): TodoList | null {
  const list = deriveTodoList(listToolCallsNamed(db, taskId, TODO_TOOLS))
  if (list === null) return null
  const closed = listRetiredTodoIds(db, taskId)
  if (closed.size === 0) return list
  return { ...list, items: list.items.filter(({ id }) => id === null || !closed.has(id)) }
}

/** The ids of a derived list its shared list folder doesn't hold, and so are stranded (#593). */
export function strandedIds(todos: readonly Todo[], live: ReadonlySet<string> | null): ReadonlySet<string> {
  const ids = new Set<string>()
  if (live !== null) for (const { id } of todos) if (id !== null && !live.has(id)) ids.add(id)
  return ids
}

/**
 * A task's todo list as its agent holds it: worked out from the tool log (`todoListFor`, closed ones out), with every
 * numbered todo the task's shared list folder no longer holds marked stranded (#593). A task with no shared folder —
 * one that hasn't started since Glade kept the list for it — is left exactly as it was: nothing of it is stranded, and
 * an item with no id (a `TodoWrite` one) never is.
 */
export function liveTodos(db: Database, taskId: string, dataDir: string | undefined): TodoList | null {
  const list = todoListFor(db, taskId)
  if (list === null || dataDir === undefined) return list
  const live = liveTodoIds(dataDir, taskId)
  if (live === null) return list
  const stranded = strandedIds(list.items, live)
  if (stranded.size === 0) return list
  return {
    ...list,
    items: list.items.map((todo) => (todo.id !== null && stranded.has(todo.id) ? { ...todo, stranded: true } : todo)),
  }
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
