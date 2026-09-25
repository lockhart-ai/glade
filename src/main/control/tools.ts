/**
 * The `glade-control` tools (`docs/control-api.md`, "Tools"), each defined once: its name, description, input schema
 * and handler over the control service. The in-process server (`./server`) serves these definitions, and so can any
 * other transport.
 *
 * Each input schema is strict: an unknown field fails it, as a missing id, blank text, a `limit` out of range or an
 * enum value Glade doesn't know do, with `invalid_input` naming the field.
 */
import { z } from 'zod'
import { Effort, PermissionMode } from '../../shared/domain'
import { MODEL_OPTIONS } from '../../shared/models'
import { ControlError, ControlErrorCode } from './errors'
import { CONTROL_TOOL_ACCESS, ControlAccess, ControlToolName } from './names'
import { requireConfirmed, TaskStateFilter, type ControlService } from './service'

/** Who is calling: one of Glade's own tasks, through its in-process server, or the HTTP endpoint (P13-03). */
export enum ControlCallerKind {
  Task = 'task',
  Http = 'http',
}

export type ControlCaller =
  | { readonly kind: ControlCallerKind.Task; readonly taskId: string }
  | { readonly kind: ControlCallerKind.Http }

/** The caller as the rate limits and the log know it: the calling task's id, or `http`. */
export function callerKey(caller: ControlCaller): string {
  switch (caller.kind) {
    case ControlCallerKind.Task:
      return caller.taskId
    case ControlCallerKind.Http:
      return ControlCallerKind.Http
  }
}

/** A tool's result: the JSON object it answers with, as `structuredContent` and as text. */
export type ControlResult = Readonly<Record<string, unknown>>

/** What a tool's handler runs with. */
export interface ControlCall {
  readonly service: ControlService
  readonly caller: ControlCaller
}

/** A tool as its schema and handler type it. */
export interface ControlToolDefinition<Input> {
  readonly name: ControlToolName
  readonly description: string
  readonly input: z.ZodType<Input>
  /** The task the call acts on, for the log and the self-guard; none by default. */
  readonly target?: (input: Input) => string | null
  /** Whether a task may not call it on itself (`forbidden`); false by default. */
  readonly forbidsSelf?: boolean
  /** Text the call sends, logged at debug only; none by default. */
  readonly text?: (input: Input) => string | null
  readonly run: (input: Input, call: ControlCall) => ControlResult | Promise<ControlResult>
}

/** A call whose input has been checked, ready to run. */
export interface PreparedCall {
  readonly target: string | null
  readonly text: string | null
  run(call: ControlCall): Promise<ControlResult>
}

/** A tool as the servers serve it, whatever its input. */
export interface ControlTool {
  readonly name: ControlToolName
  readonly description: string
  readonly access: ControlAccess
  readonly forbidsSelf: boolean
  /** Its input schema, as JSON Schema, for `tools/list`. */
  readonly inputSchema: Readonly<Record<string, unknown>>
  /** Checks a call's input: throws `invalid_input`, naming the field, when it doesn't fit. */
  prepare(input: unknown): PreparedCall
}

/** What was wrong with an input, one problem per field: `limit: Too big: expected number to be <=100`. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.')
      if (issue.code === 'unrecognized_keys') {
        const fields = issue.keys.map((key) => (path === '' ? key : `${path}.${key}`))
        return `${fields.join(', ')}: unknown field`
      }
      return `${path === '' ? 'input' : path}: ${issue.message}`
    })
    .join('; ')
}

/** An input schema as JSON Schema, as MCP lists it: the object, without the `$schema` dialect line. */
function jsonSchemaOf(input: z.ZodType): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(z.toJSONSchema(input, { io: 'input' })).filter(([key]) => key !== '$schema'))
}

/** A tool, from its definition. */
export function defineControlTool<Input>(definition: ControlToolDefinition<Input>): ControlTool {
  const { name, description, input, target, forbidsSelf = false, text, run } = definition
  return {
    name,
    description,
    access: CONTROL_TOOL_ACCESS[name],
    forbidsSelf,
    inputSchema: jsonSchemaOf(input),
    prepare(raw) {
      const parsed = input.safeParse(raw ?? {})
      if (!parsed.success) throw new ControlError(ControlErrorCode.InvalidInput, describeIssues(parsed.error))
      const value = parsed.data
      return {
        target: target?.(value) ?? null,
        text: text?.(value) ?? null,
        run: async (call) => run(value, call),
      }
    },
  }
}

// The inputs' parts.

/** A Glade id, e.g. a task's. */
const id = (what: string) => z.string().trim().min(1, 'is empty').describe(`The ${what}'s id.`)

/** Text: trimmed, and never empty. */
const text = (description: string) => z.string().trim().min(1, 'is empty').describe(description)

/** A page size, from 1 to `max`. */
const limit = (max: number, fallback: number, what: string) =>
  z
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(`How many ${what} a page holds, 1–${String(max)}; ${String(fallback)} by default.`)

/** A model Glade offers, by the id the SDK takes. */
const model = z
  .enum(Object.fromEntries(MODEL_OPTIONS.map((option) => [option.id, option.id])))
  .describe('The model, by id: ' + MODEL_OPTIONS.map((option) => `${option.id} (${option.name})`).join(', ') + '.')

const effort = z.enum(Effort).describe('How hard the agent thinks.')

const permissionMode = z
  .enum(PermissionMode)
  .describe(`${PermissionMode.AllowAll} runs every tool call; ${PermissionMode.AskBeforeEdits} asks the user first.`)

const byId = z.strictObject({ id: id('task') })

// The inputs, each checked against the interface the service takes, so the two can't drift apart.

const listTasksInput = z.strictObject({
  workspaceId: id('workspace').optional().describe("Only this workspace's tasks; every workspace's by default."),
  state: z.enum(TaskStateFilter).optional().describe('Active, done or all tasks; all by default.'),
  query: text("Full-text search over the tasks' titles, objectives, statuses and chats.").optional(),
  cursor: z.string().min(1).optional().describe('The nextCursor of the page before, for the next page.'),
  limit: limit(100, 50, 'tasks'),
})

const getChatInput = z.strictObject({
  id: id('task'),
  fromTurn: z.int().min(1).optional().describe('The first turn to read, from 1; 1 by default.'),
  limit: limit(50, 20, 'turns'),
  includeTools: z.boolean().optional().describe("Whether to list each turn's tool calls; true by default."),
})

const createTaskInput = z.strictObject({
  workspaceId: id('workspace'),
  message: text('The first message. Sending it starts the agent; without one the task waits for it.').optional(),
  title: text("The task's title, so the agent doesn't set one.").optional(),
  objective: text("The task's objective, so the agent doesn't set one.").optional(),
  model: model.optional(),
  effort: effort.optional(),
  permissionMode: permissionMode.optional(),
})

const updateTaskInput = z.strictObject({
  id: id('task'),
  patch: z
    .strictObject({
      title: text('A new title.').optional(),
      objective: text('A new objective.').optional(),
      status: text('A new one-line status.').optional(),
      pinned: z.boolean().optional(),
      unread: z.boolean().optional(),
      model: model.optional(),
      effort: effort.optional(),
      permissionMode: permissionMode.optional(),
    })
    .refine((patch) => Object.keys(patch).length > 0, 'changes nothing')
    .describe('The fields to change; the ones left out keep their value.'),
})

const sendMessageInput = z.strictObject({
  id: id('task'),
  text: text('The message, as if typed into the task’s input bar.'),
})

const deleteTaskInput = z.strictObject({
  id: id('task'),
  confirm: z.boolean().optional().describe('Must be true: deleting a task can’t be undone.'),
})

// The tools.

const taskOf = ({ id }: { readonly id: string }): string => id

/** The task tools: workspaces and tasks, read and changed. */
export const TASK_TOOLS: readonly ControlTool[] = [
  defineControlTool({
    name: ControlToolName.ListWorkspaces,
    description: "List Glade's workspaces (named root folders), each with how many active and done tasks it has.",
    input: z.strictObject({}),
    run: (_input, { service }) => ({ workspaces: service.listWorkspaces() }),
  }),
  defineControlTool({
    name: ControlToolName.ListTasks,
    description:
      "List Glade's tasks: in one workspace or all, active, done or all, optionally matching a full-text query. " +
      'Without a query, pinned first, then most recently updated first; with one, best match first. Page with ' +
      'nextCursor: a listing keeps the order its first page had, so tasks changing meanwhile are never skipped or ' +
      'listed twice.',
    input: listTasksInput,
    run: (input, { service }) => ({
      ...service.listTasks({
        workspaceId: input.workspaceId ?? null,
        state: input.state ?? TaskStateFilter.All,
        query: input.query ?? null,
        cursor: input.cursor,
        limit: input.limit ?? 50,
      }),
    }),
  }),
  defineControlTool({
    name: ControlToolName.GetTask,
    description:
      "Read a task: everything its header and sidebar row show (title, objective, status, state, what its agent is " +
      "doing, model, effort, permission mode, context used, error, pause, queue) and its number of turns.",
    input: byId,
    target: taskOf,
    run: ({ id }, { service }) => ({ task: service.getTask(id) }),
  }),
  defineControlTool({
    name: ControlToolName.GetChat,
    description:
      "Read a task's chat by turn: the user's messages and the agent's final replies, each turn's start time and, " +
      'unless includeTools is false, its tool calls as one-line summaries. A body over 20,000 characters is cut, ' +
      'with truncated: true. Page with nextFromTurn; get_task says how many turns there are.',
    input: getChatInput,
    target: taskOf,
    run: (input, { service }) => ({
      ...service.getChat({
        id: input.id,
        fromTurn: input.fromTurn ?? 1,
        limit: input.limit ?? 20,
        includeTools: input.includeTools ?? true,
      }),
    }),
  }),
  defineControlTool({
    name: ControlToolName.CreateTask,
    description:
      'Create a task in a workspace, as New task does. With a message, sends it, which starts the agent; without ' +
      "one, the task waits. Title and objective, if given, are set now; model, effort and permission mode default to " +
      "Settings'.",
    input: createTaskInput,
    text: (input) => input.message ?? null,
    run: (input, { service }) => ({ task: service.createTask(input) }),
  }),
  defineControlTool({
    name: ControlToolName.UpdateTask,
    description:
      'Change a task: its title, objective, one-line status, pin, unread flag, model, effort or permission mode. A new ' +
      "permission mode applies from the agent's next tool call. Use mark_done and reopen_task for its state.",
    input: updateTaskInput,
    target: taskOf,
    run: ({ id, patch }, { service }) => ({ task: service.updateTask(id, patch) }),
  }),
  defineControlTool({
    name: ControlToolName.SendMessage,
    description:
      "Send a task a message, as its input bar does: sent when its agent is idle (reopening a done task), queued " +
      'while it works, a permission card waits or it is paused, and taken as the answer when its agent has asked ' +
      'questions. Says which it was. A task cannot message itself.',
    input: sendMessageInput,
    target: taskOf,
    forbidsSelf: true,
    text: (input) => input.text,
    run: ({ id, text }, { service }) => ({ ...service.sendMessage(id, text) }),
  }),
  defineControlTool({
    name: ControlToolName.StopTask,
    description:
      "Stop a task's agent, as the Stop button does: it interrupts the running turn and withdraws an open question " +
      'or permission request. Does nothing to an idle task. A task cannot stop itself.',
    input: byId,
    target: taskOf,
    forbidsSelf: true,
    run: async ({ id }, { service }) => ({ task: await service.stopTask(id) }),
  }),
  defineControlTool({
    name: ControlToolName.MarkDone,
    description: "Mark an active task done, as the header's Mark done does. Its status stays, as its outcome.",
    input: byId,
    target: taskOf,
    run: ({ id }, { service }) => ({ task: service.markDone(id) }),
  }),
  defineControlTool({
    name: ControlToolName.ReopenTask,
    description: "Reopen a done task, as the header's Reopen does.",
    input: byId,
    target: taskOf,
    run: ({ id }, { service }) => ({ task: service.reopenTask(id) }),
  }),
  defineControlTool({
    name: ControlToolName.DeleteTask,
    description:
      "Delete a task and its chat, tool log and queue, as Delete task… does. Nothing on disk is touched. It can't be " +
      'undone, so it needs confirm: true. A task cannot delete itself.',
    input: deleteTaskInput,
    target: taskOf,
    forbidsSelf: true,
    run: ({ id, confirm }, { service }) => {
      requireConfirmed(confirm)
      return { ...service.deleteTask(id) }
    },
  }),
]

/**
 * Every `glade-control` tool, in the order `tools/list` gives them. More are added by listing their definitions here.
 */
export const CONTROL_TOOLS: readonly ControlTool[] = [...TASK_TOOLS]
