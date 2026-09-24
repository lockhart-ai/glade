// Request schemas live on the main side only, so the renderer never bundles zod for them.
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import {
  CommandName,
  type ArtifactsRemoveRequest,
  type ClipboardWriteTextRequest,
  type CommandRequest,
  type EmptyRequest,
  type FileRequest,
  type QueueAddRequest,
  type QueueEditRequest,
  type QueueRemoveRequest,
  type QuestionsAnswerRequest,
  type SearchQueryRequest,
  type SubagentsStopRequest,
  type TaskIdRequest,
  type TasksCreateRequest,
  type TasksRetryRequest,
  type TasksSendRequest,
  type TasksUpdateRequest,
  type TasksListRequest,
  type UiStateGetRequest,
  type UiStateSetRequest,
  type WorkspacesCreateRequest,
  type WorkspacesOpenRequest,
  type SettingsUpdateRequest,
  type WorkspacesUpdateRequest,
  type WorkspacesRevealRequest,
} from '../../shared/bridge'
import { Effort, UiStateKey } from '../../shared/domain'
import { isWorkspaceRelativePath } from '../../shared/files'
import { SETTING_SCHEMAS } from '../db/repositories/settings'
import { questionAnswersSchema } from '../questions/schema'

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

/** An absolute path, which main resolves. */
const absolutePath = z.string().refine((path) => isAbsolute(path), 'Expected an absolute path')

const workspacesUpdateRequest = z.strictObject({
  id: z.string(),
  patch: z.strictObject({
    name: z
      .string()
      .refine((name) => name.trim() !== '', 'Expected a name that is not blank')
      .optional(),
    rootPath: absolutePath.optional(),
  }),
}) satisfies z.ZodType<WorkspacesUpdateRequest>
const workspacesRevealRequest = z.strictObject({ id: z.string() }) satisfies z.ZodType<WorkspacesRevealRequest>

const tasksListRequest = z.strictObject({ workspaceId: z.string() }) satisfies z.ZodType<TasksListRequest>

const tasksCreateRequest = z.strictObject({ workspaceId: z.string() }) satisfies z.ZodType<TasksCreateRequest>

const taskIdRequest = z.strictObject({ id: z.string() }) satisfies z.ZodType<TaskIdRequest>

/** Text that mustn't be blank. */
function notBlank(what: string): z.ZodType<string> {
  return z.string().refine((text) => text.trim() !== '', `Expected ${what} that is not blank`)
}

const tasksUpdateRequest = z.strictObject({
  id: z.string(),
  patch: z.strictObject({
    title: notBlank('a title').optional(),
    pinned: z.boolean().optional(),
    unread: z.boolean().optional(),
    model: z.string().min(1).optional(),
    effort: z.enum(Effort).optional(),
  }),
}) satisfies z.ZodType<TasksUpdateRequest>

/** A message's text, which mustn't be blank. */
const messageText = notBlank('a message')

const tasksSendRequest = z.strictObject({ id: z.string(), text: messageText }) satisfies z.ZodType<TasksSendRequest>

const tasksRetryRequest = z.strictObject({
  id: z.string(),
  model: z.string().min(1).optional(),
}) satisfies z.ZodType<TasksRetryRequest>

const subagentsStopRequest = z.strictObject({
  taskId: z.string(),
  toolUseId: z.string(),
}) satisfies z.ZodType<SubagentsStopRequest>

const queueAddRequest = z.strictObject({ taskId: z.string(), text: messageText }) satisfies z.ZodType<QueueAddRequest>

const queueEditRequest = z.strictObject({ id: z.string(), text: messageText }) satisfies z.ZodType<QueueEditRequest>

const queueRemoveRequest = z.strictObject({ id: z.string() }) satisfies z.ZodType<QueueRemoveRequest>

const questionsAnswerRequest = z.strictObject({
  id: z.string(),
  answers: questionAnswersSchema,
}) satisfies z.ZodType<QuestionsAnswerRequest>

const fileRequest = z.strictObject({
  taskId: z.string(),
  path: z
    .string()
    .refine(isWorkspaceRelativePath, 'Expected a normalized path relative to the workspace root, inside it'),
}) satisfies z.ZodType<FileRequest>

const settingsUpdateRequest = z.strictObject({
  patch: z.strictObject(SETTING_SCHEMAS).partial(),
}) satisfies z.ZodType<SettingsUpdateRequest>
const artifactsRemoveRequest = z.strictObject({
  taskId: z.string(),
  path: z.string(),
}) satisfies z.ZodType<ArtifactsRemoveRequest>

const clipboardWriteTextRequest = z.strictObject({ text: z.string() }) satisfies z.ZodType<ClipboardWriteTextRequest>

const uiStateGetRequest = z.strictObject({ key: z.enum(UiStateKey) }) satisfies z.ZodType<UiStateGetRequest>

const uiStateSetRequest = z.strictObject({
  key: z.enum(UiStateKey),
  value: z.string(),
}) satisfies z.ZodType<UiStateSetRequest>

const searchQueryRequest = z.strictObject({
  workspaceId: z.string(),
  text: z.string(),
}) satisfies z.ZodType<SearchQueryRequest>

export const REQUEST_SCHEMAS = {
  [CommandName.WorkspacesList]: emptyRequest,
  [CommandName.WorkspacesCreate]: workspacesCreateRequest,
  [CommandName.WorkspacesOpen]: workspacesOpenRequest,
  [CommandName.WorkspacesUpdate]: workspacesUpdateRequest,
  [CommandName.WorkspacesReveal]: workspacesRevealRequest,
  [CommandName.DialogChooseFolder]: emptyRequest,
  [CommandName.TasksList]: tasksListRequest,
  [CommandName.TasksCreate]: tasksCreateRequest,
  [CommandName.TasksMarkDone]: taskIdRequest,
  [CommandName.TasksReopen]: taskIdRequest,
  [CommandName.TasksUpdate]: tasksUpdateRequest,
  [CommandName.TasksDelete]: taskIdRequest,
  [CommandName.TasksSend]: tasksSendRequest,
  [CommandName.TasksStop]: taskIdRequest,
  [CommandName.TasksRetry]: tasksRetryRequest,
  [CommandName.TasksCompact]: taskIdRequest,
  [CommandName.SubagentsStop]: subagentsStopRequest,
  [CommandName.TasksHistory]: taskIdRequest,
  [CommandName.QueueAdd]: queueAddRequest,
  [CommandName.QueueEdit]: queueEditRequest,
  [CommandName.QueueRemove]: queueRemoveRequest,
  [CommandName.QuestionsAnswer]: questionsAnswerRequest,
  [CommandName.FilesRead]: fileRequest,
  [CommandName.FilesOpen]: fileRequest,
  [CommandName.FilesClose]: fileRequest,
  [CommandName.FilesOpenInEditor]: fileRequest,
  [CommandName.ClipboardWriteText]: clipboardWriteTextRequest,
  [CommandName.FilesInfo]: fileRequest,
  [CommandName.FilesCopy]: fileRequest,
  [CommandName.FilesReveal]: fileRequest,
  [CommandName.ArtifactsRemove]: artifactsRemoveRequest,
  [CommandName.UiStateGet]: uiStateGetRequest,
  [CommandName.UiStateGetAll]: emptyRequest,
  [CommandName.UiStateSet]: uiStateSetRequest,
  [CommandName.SettingsGet]: emptyRequest,
  [CommandName.SettingsUpdate]: settingsUpdateRequest,
  [CommandName.SearchQuery]: searchQueryRequest,
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
