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
 */
import type { Database } from 'better-sqlite3'
import {
  TodoState,
  ToolCallState,
  type EpochMs,
  type Todo,
  type TodoList,
  type ToolCallEvent,
} from '../../shared/domain'
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

/** An item as the tools know it: its id (`TaskCreate`'s; null for `TodoWrite`'s), text, status and active form. */
interface Item {
  readonly id: string | null
  readonly text: string
  readonly status: ClaudeTodoStatus
  readonly activeForm: string | undefined
}

/** Whether a call can change the todo list: a finished, successful call of the main agent to a todo tool. */
export function changesTodos(call: ToolCallEvent): boolean {
  return call.parentToolUseId === null && call.state === ToolCallState.Done && TODO_TOOLS.includes(call.name)
}

function toTodo({ text, status, activeForm }: Item): Todo {
  const state = STATES[status]
  const note = state === TodoState.Doing && activeForm !== undefined && activeForm.trim() !== '' ? activeForm : null
  return { text, state, note }
}

function updated(item: Item, { subject, activeForm, status }: TaskUpdateInput): Item {
  return {
    ...item,
    text: subject ?? item.text,
    activeForm: activeForm ?? item.activeForm,
    status: status === undefined || status === DELETED_STATUS ? item.status : status,
  }
}

/** The list after one call; null when the call's input doesn't parse, so it changed nothing. */
function apply(items: readonly Item[], call: ToolCallEvent): readonly Item[] | null {
  switch (call.name as TodoTool) {
    case TodoTool.TodoWrite: {
      const input = todoWriteInput.safeParse(call.input)
      if (!input.success) return null
      return input.data.todos.map(({ content, status, activeForm }) => ({
        id: null,
        text: content,
        status,
        activeForm,
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
      }
      return [...items.filter((existing) => id === null || existing.id !== id), item]
    }
    case TodoTool.TaskUpdate: {
      const input = taskUpdateInput.safeParse(call.input)
      if (!input.success) return null
      const change = input.data
      if (change.status === DELETED_STATUS) return items.filter(({ id }) => id !== change.taskId)
      return items.map((item) => (item.id === change.taskId ? updated(item, change) : item))
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
