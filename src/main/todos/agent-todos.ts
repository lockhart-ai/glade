/**
 * `create_todo`, `update_todo` and `list_todos` (#609): the agent's own tools for keeping a task's todos, in Glade's
 * database, in place of Claude Code's `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet`/`TodoWrite`, which no Glade
 * session is offered any more (`../agent/sdk-backend`'s `DISALLOWED_TOOLS`).
 *
 * The tools' own words stay close to the built-ins' (`subject`, `status` of `pending`/`in_progress`/`completed`/
 * `deleted`), so a model's habits with them carry over; what's stored keeps Glade's own (`Todo.text`, `Todo.note`,
 * `Todo.state`). A note shows for a todo in any state but done, not only a doing one, since Glade owns the list now
 * (`../db/repositories/glade-todos`'s plain store has no rule of its own about it; this is where one lives).
 */
import type { Database } from 'better-sqlite3'
import { BridgeErrorCode } from '../../shared/bridge'
import { TodoState } from '../../shared/domain'
import { CommandFailure } from '../bridge/errors'
import { emitTaskUpdated, emitTodosChanged } from '../bridge/events'
import { createTodo, deleteTodo, updateTodo as updateTodoRow } from '../db/repositories/glade-todos'
import {
  childLabel,
  filingTodos,
  nameSome,
  NO_TODOS,
  noSuchTodo,
  todoIdOf,
  todoLabel,
  type FilingTodo,
} from '../todo-hub/agent-children'
import { taskChildren, type FilingContext } from '../todo-hub/todo-hub'
import { refreshTodos, todoListFor } from './todos'

/**
 * `update_todo`'s `status`, in the built-ins' own words, plus Glade's own `waiting` (#680); `deleted` removes the
 * todo instead of changing its state.
 */
export type TodoToolStatus = 'pending' | 'in_progress' | 'completed' | 'waiting' | 'deleted'

const STATUS_TO_STATE: Readonly<Record<'pending' | 'in_progress' | 'completed' | 'waiting', TodoState>> = {
  pending: TodoState.Todo,
  in_progress: TodoState.Doing,
  completed: TodoState.Done,
  waiting: TodoState.Waiting,
}

const STATE_TO_STATUS: Readonly<Record<TodoState, string>> = {
  [TodoState.Todo]: 'pending',
  [TodoState.Doing]: 'in_progress',
  [TodoState.Done]: 'completed',
  [TodoState.Waiting]: 'waiting',
}

/** `create_todo`'s input. */
export interface CreateTodoInput {
  readonly subject: string
  readonly note?: string | undefined
}

/** `update_todo`'s input: at least one of `subject`, `note` and `status` besides `id`. */
export interface UpdateTodoInput {
  readonly id: string
  readonly subject?: string | undefined
  readonly note?: string | undefined
  readonly status?: TodoToolStatus | undefined
}

/** What `update_todo` tells the model when it gives none of `subject`, `note` or `status`. */
export const UPDATE_TODO_CHANGES_NOTHING =
  'Give a new subject, note or status: an update with none of them changes nothing.'

/** Works the task's todo list and row summary out again, and tells the windows. */
function announce({ db, emit }: FilingContext, taskId: string): void {
  const { changed } = refreshTodos(db, taskId)
  emitTodosChanged(emit, taskId, todoListFor(db, taskId))
  if (changed !== null) emitTaskUpdated(emit, changed)
}

/** `create_todo`: adds a todo, not started, with the next id the task has ever been given. */
export function createTodoForAgent(context: FilingContext, taskId: string, input: CreateTodoInput): string {
  const todo = createTodo(context.db, taskId, { text: input.subject, note: input.note ?? null })
  announce(context, taskId)
  return `Todo #${todo.id} created: ${todo.text}.`
}

/** The task's todo of this id, as `update_todo` can act on; a tool error naming the task's todos when it has none. */
function requireTodo(db: Database, taskId: string, given: string): FilingTodo {
  const id = todoIdOf(given)
  const todos = filingTodos(taskChildren(db, taskId).todos)
  const todo = todos.find((candidate) => candidate.id === id)
  if (todo === undefined) throw new CommandFailure(BridgeErrorCode.InvalidRequest, noSuchTodo([id], todos))
  return todo
}

/**
 * `update_todo`: changes a todo's subject, note or status, or — `status: "deleted"` — removes it, refused while
 * anything is still filed under it, naming each so the agent can move it with `file_children` first.
 */
export function updateTodoForAgent(context: FilingContext, taskId: string, input: UpdateTodoInput): string {
  const { db } = context
  const todo = requireTodo(db, taskId, input.id)
  if (input.status === 'deleted') {
    const children = taskChildren(db, taskId)
    const stillFiled = children.filings.filter((filing) => filing.todoId === todo.id)
    if (stillFiled.length > 0) {
      const named = nameSome(db, taskId, children, stillFiled).map(childLabel).join(', ')
      throw new CommandFailure(
        BridgeErrorCode.InvalidRequest,
        `Todo ${todoLabel(todo)} still has children filed under it: ${named}. Move each to the todo it belongs ` +
          'under with file_children, then delete it.',
      )
    }
    deleteTodo(db, taskId, todo.id)
    announce(context, taskId)
    return `Deleted todo ${todoLabel(todo)}.`
  }
  if (input.subject === undefined && input.note === undefined && input.status === undefined) {
    throw new CommandFailure(BridgeErrorCode.InvalidRequest, UPDATE_TODO_CHANGES_NOTHING)
  }
  updateTodoRow(db, taskId, todo.id, {
    ...(input.subject === undefined ? {} : { text: input.subject }),
    // A note is for a todo in any state but done: completing one drops its old note, so a stale spinner line
    // doesn't read wrongly once it's finished — but a note the same call gives is kept (a line like "Merged Oct
    // 12" is exactly what a finished todo wants).
    ...(input.note !== undefined ? { note: input.note } : input.status === 'completed' ? { note: null } : {}),
    ...(input.status === undefined ? {} : { state: STATUS_TO_STATE[input.status] }),
  })
  announce(context, taskId)
  return `Todo #${todo.id} updated.`
}

/** A todo as `list_todos` answers it: `#1 [in_progress] Write the release notes — Drafting the changelog`. */
function todoLine({ id, text, state, note }: FilingTodo): string {
  const line = `#${id} [${STATE_TO_STATUS[state]}] ${text}`
  return note === null ? line : `${line} — ${note}`
}

/** `list_todos`: every todo of the task, in order, one line each. */
export function listTodosForAgent(db: Database, taskId: string): string {
  const todos = filingTodos(taskChildren(db, taskId).todos)
  return todos.length === 0 ? NO_TODOS : todos.map(todoLine).join('\n')
}
