// Request schemas live on the main side only, so the renderer never bundles zod for them.
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import {
  CommandName,
  type CommandRequest,
  type EmptyRequest,
  type TaskIdRequest,
  type TasksCreateRequest,
  type TasksSendRequest,
  type TasksUpdateRequest,
  type TasksListRequest,
  type UiStateGetRequest,
  type UiStateSetRequest,
  type WorkspacesCreateRequest,
  type WorkspacesOpenRequest,
} from '../../shared/bridge'
import { Effort, UiStateKey } from '../../shared/domain'

/**
 * A zod schema for each command's request, which arrives from the renderer as `unknown`. The named interfaces in
 * `shared/bridge.ts` stay the source of truth: each schema must parse to its command's request type, and a command
 * without a schema fails the typecheck. (`types.test.ts` also checks the other way: no schema parses extra fields.)
 */
export type RequestSchemas = { readonly [C in CommandName]: z.ZodType<CommandRequest<C>> }

const emptyRequest = z.strictObject({}) satisfies z.ZodType<EmptyRequest>

const workspacesCreateRequest = z.strictObject({
  rootPath: z.string().refine((path) => isAbsolute(path), 'Expected an absolute path'),
}) satisfies z.ZodType<WorkspacesCreateRequest>

const workspacesOpenRequest = z.strictObject({ id: z.string() }) satisfies z.ZodType<WorkspacesOpenRequest>

const tasksListRequest = z.strictObject({ workspaceId: z.string() }) satisfies z.ZodType<TasksListRequest>

const tasksCreateRequest = z.strictObject({ workspaceId: z.string() }) satisfies z.ZodType<TasksCreateRequest>

const taskIdRequest = z.strictObject({ id: z.string() }) satisfies z.ZodType<TaskIdRequest>

const tasksUpdateRequest = z.strictObject({
  id: z.string(),
  patch: z.strictObject({
    title: z.string().optional(),
    pinned: z.boolean().optional(),
    unread: z.boolean().optional(),
    model: z.string().min(1).optional(),
    effort: z.enum(Effort).optional(),
  }),
}) satisfies z.ZodType<TasksUpdateRequest>

const tasksSendRequest = z.strictObject({
  id: z.string(),
  text: z.string().refine((text) => text.trim() !== '', 'Expected a message that is not blank'),
}) satisfies z.ZodType<TasksSendRequest>
const uiStateGetRequest = z.strictObject({ key: z.enum(UiStateKey) }) satisfies z.ZodType<UiStateGetRequest>

const uiStateSetRequest = z.strictObject({
  key: z.enum(UiStateKey),
  value: z.string(),
}) satisfies z.ZodType<UiStateSetRequest>

export const REQUEST_SCHEMAS = {
  [CommandName.WorkspacesList]: emptyRequest,
  [CommandName.WorkspacesCreate]: workspacesCreateRequest,
  [CommandName.WorkspacesOpen]: workspacesOpenRequest,
  [CommandName.DialogChooseFolder]: emptyRequest,
  [CommandName.TasksList]: tasksListRequest,
  [CommandName.TasksCreate]: tasksCreateRequest,
  [CommandName.TasksMarkDone]: taskIdRequest,
  [CommandName.TasksReopen]: taskIdRequest,
  [CommandName.TasksUpdate]: tasksUpdateRequest,
  [CommandName.TasksSend]: tasksSendRequest,
  [CommandName.TasksHistory]: taskIdRequest,
  [CommandName.UiStateGet]: uiStateGetRequest,
  [CommandName.UiStateGetAll]: emptyRequest,
  [CommandName.UiStateSet]: uiStateSetRequest,
} as const satisfies RequestSchemas

/** A short, readable account of why a request didn't parse: each problem as `field: message`, joined by `; `. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.')
      return path === '' ? issue.message : `${path}: ${issue.message}`
    })
    .join('; ')
}
