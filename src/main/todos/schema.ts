/**
 * The zod schemas for the inputs of Claude Code's own todo tools, which the Todos tab maps (`./todos`). Their shapes are
 * the SDK's (`TodoWriteInput`, `TaskCreateInput` and `TaskUpdateInput` in `@anthropic-ai/claude-agent-sdk/sdk-tools`),
 * trimmed to the fields Glade reads; other fields are ignored. They live on the main side only, so the renderer never
 * bundles zod for them.
 */
import { z } from 'zod'

/** Where an item stands, as Claude Code's todo tools say it. */
export enum ClaudeTodoStatus {
  Pending = 'pending',
  InProgress = 'in_progress',
  Completed = 'completed',
}

/** `TaskUpdate`'s status can also remove the task. */
export const DELETED_STATUS = 'deleted'

const status = z.enum(ClaudeTodoStatus)

/** `TodoWrite`: the whole list, each time. */
export const todoWriteInput = z.object({
  todos: z.array(
    z.object({
      content: z.string(),
      status,
      activeForm: z.string().optional(),
    }),
  ),
})

export type TodoWriteInput = z.infer<typeof todoWriteInput>

/** `TaskCreate`: one new item, pending. Its id comes back in the result (see `createdTaskId`). */
export const taskCreateInput = z.object({
  subject: z.string(),
  activeForm: z.string().optional(),
})

export type TaskCreateInput = z.infer<typeof taskCreateInput>

/** `TaskUpdate`: changes to one item, by id. */
export const taskUpdateInput = z.object({
  taskId: z.string(),
  subject: z.string().optional(),
  activeForm: z.string().optional(),
  status: z.union([status, z.literal(DELETED_STATUS)]).optional(),
})

export type TaskUpdateInput = z.infer<typeof taskUpdateInput>

/** `TaskCreate`'s result reads `Task #3 created successfully: <subject>`. */
const CREATED = /^Task #(\S+) created/

/** The id `TaskCreate` gave its new item, from the call's result; undefined when the result doesn't say. */
export function createdTaskId(output: string): string | undefined {
  return CREATED.exec(output)?.[1]
}
