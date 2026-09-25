// Request schemas live on the main side only, so the renderer never bundles zod for them.
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import {
  CommandName,
  MAX_RENDERER_ERROR_TEXT,
  RendererErrorKind,
  type ArtifactsRemoveRequest,
  type ClipboardWriteTextRequest,
  type CommandRequest,
  type EmptyRequest,
  type FileRequest,
  type ImagesGetRequest,
  type LogRendererErrorRequest,
  type MenuUpdateRequest,
  type QueueAddRequest,
  type QueueEditRequest,
  type QueueRemoveRequest,
  type QuestionsAnswerRequest,
  type SearchQueryRequest,
  type SubagentsStopRequest,
  type TaskIdRequest,
  type TasksGetRequest,
  type TasksListDoneRequest,
  type TerminalCreateRequest,
  type TerminalIdRequest,
  type TerminalRenameRequest,
  type TerminalSizeRequest,
  type TerminalWriteRequest,
  type TasksCreateRequest,
  type TasksRetryRequest,
  type TasksSendRequest,
  type TasksUpdateRequest,
  type TasksListRequest,
  type UiStateGetRequest,
  type UiStateSetRequest,
  type WorkspacesCreateRequest,
  type WorkspacesOpenRequest,
  type WorkspacesRemoveRequest,
  type SettingsUpdateRequest,
  type WorkspacesUpdateRequest,
  type WorkspacesRevealRequest,
} from '../../shared/bridge'
import { TaskFilter } from '../../shared/attention'
import { MAX_DONE_PAGE_SIZE } from '../../shared/doneList'
import { Effort, UiStateKey } from '../../shared/domain'
import { isWorkspaceRelativePath } from '../../shared/files'
import { hasImageSignature, ImageMediaType, MAX_IMAGE_BASE64_LENGTH, type ImageData } from '../../shared/images'
import { MAX_TERMINAL_NAME, MAX_TERMINAL_SIZE, MAX_TERMINAL_WRITE } from '../../shared/terminal'
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

const workspacesRemoveRequest = z.strictObject({ id: z.string() }) satisfies z.ZodType<WorkspacesRemoveRequest>

const tasksListRequest = z.strictObject({ workspaceId: z.string() }) satisfies z.ZodType<TasksListRequest>

const tasksListDoneRequest = z.strictObject({
  workspaceId: z.string(),
  filter: z.enum(TaskFilter),
  after: z.strictObject({ updatedAt: z.int().nonnegative(), id: z.string() }).nullable(),
  limit: z.int().min(1).max(MAX_DONE_PAGE_SIZE),
}) satisfies z.ZodType<TasksListDoneRequest>

const tasksGetRequest = z.strictObject({
  ids: z.array(z.string()).readonly(),
}) satisfies z.ZodType<TasksGetRequest>

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

/** Base64, as `Buffer.from(…, 'base64')` would otherwise read anything into some bytes. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** A pasted image: a type the agent takes, within the API's size limit, whose bytes are that type. */
const image = z
  .strictObject({
    mediaType: z.enum(ImageMediaType),
    data: z.string().min(1).max(MAX_IMAGE_BASE64_LENGTH).regex(BASE64, 'Expected base64'),
  })
  .refine(({ mediaType, data }) => hasImageSignature(mediaType, Buffer.from(data.slice(0, 64), 'base64')), {
    message: "Expected the image's bytes to be its type",
    // Only once its type and data are good: there's nothing to check otherwise.
    when: ({ issues }) => issues.length === 0,
  }) satisfies z.ZodType<ImageData>

/** A message's text and images: its text can be blank only when it has images. */
function withContent<T extends { readonly text: string; readonly images?: readonly ImageData[] | undefined }>(
  schema: z.ZodType<T>,
): z.ZodType<T> {
  return schema.refine(({ text, images = [] }) => text.trim() !== '' || images.length > 0, {
    message: 'Expected a message that is not blank',
    path: ['text'],
  })
}

const tasksSendRequest = withContent(
  z.strictObject({ id: z.string(), text: z.string(), images: z.array(image).readonly().optional() }),
) satisfies z.ZodType<TasksSendRequest>

const tasksRetryRequest = z.strictObject({
  id: z.string(),
  model: z.string().min(1).optional(),
}) satisfies z.ZodType<TasksRetryRequest>

const subagentsStopRequest = z.strictObject({
  taskId: z.string(),
  toolUseId: z.string(),
}) satisfies z.ZodType<SubagentsStopRequest>

const queueAddRequest = withContent(
  z.strictObject({ taskId: z.string(), text: z.string(), images: z.array(image).readonly().optional() }),
) satisfies z.ZodType<QueueAddRequest>

const queueEditRequest = z.strictObject({ id: z.string(), text: messageText }) satisfies z.ZodType<QueueEditRequest>

const queueRemoveRequest = z.strictObject({ id: z.string() }) satisfies z.ZodType<QueueRemoveRequest>

const imagesGetRequest = z.strictObject({ id: z.string() }) satisfies z.ZodType<ImagesGetRequest>

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

const terminalCreateRequest = z.strictObject({
  workspaceId: z.string().nullable(),
}) satisfies z.ZodType<TerminalCreateRequest>

const terminalIdRequest = z.strictObject({ id: z.string() }) satisfies z.ZodType<TerminalIdRequest>

/** A terminal's columns or rows. */
const terminalCells = z.number().int().min(1).max(MAX_TERMINAL_SIZE)

const terminalSizeRequest = z.strictObject({
  id: z.string(),
  cols: terminalCells,
  rows: terminalCells,
}) satisfies z.ZodType<TerminalSizeRequest>

const terminalWriteRequest = z.strictObject({
  id: z.string(),
  data: z.string().max(MAX_TERMINAL_WRITE),
}) satisfies z.ZodType<TerminalWriteRequest>

const terminalRenameRequest = z.strictObject({
  id: z.string(),
  name: z
    .string()
    .max(MAX_TERMINAL_NAME)
    .refine((name) => name.trim() !== '', 'Expected a name that is not blank'),
}) satisfies z.ZodType<TerminalRenameRequest>

const menuUpdateRequest = z.strictObject({
  workspaces: z.array(z.strictObject({ id: z.string(), name: z.string() })).readonly(),
  shownWorkspaceId: z.string().nullable(),
  task: z
    .strictObject({
      id: z.string(),
      pinned: z.boolean(),
      canRename: z.boolean(),
      canMarkUnread: z.boolean(),
      canMarkDone: z.boolean(),
      canReopen: z.boolean(),
      canCopyOutcome: z.boolean(),
    })
    .nullable(),
  panels: z.strictObject({ sidebar: z.boolean(), rightPanel: z.boolean(), bottomBar: z.boolean() }),
  keyBindings: SETTING_SCHEMAS.keyBindings,
}) satisfies z.ZodType<MenuUpdateRequest>

const rendererErrorText = z.string().max(MAX_RENDERER_ERROR_TEXT)

const logRendererErrorRequest = z.strictObject({
  kind: z.enum(RendererErrorKind),
  message: rendererErrorText,
  stack: rendererErrorText.nullable(),
  componentStack: rendererErrorText.nullable(),
  source: rendererErrorText.nullable(),
}) satisfies z.ZodType<LogRendererErrorRequest>

export const REQUEST_SCHEMAS = {
  [CommandName.WorkspacesList]: emptyRequest,
  [CommandName.WorkspacesCreate]: workspacesCreateRequest,
  [CommandName.WorkspacesOpen]: workspacesOpenRequest,
  [CommandName.WorkspacesUpdate]: workspacesUpdateRequest,
  [CommandName.WorkspacesReveal]: workspacesRevealRequest,
  [CommandName.WorkspacesRemove]: workspacesRemoveRequest,
  [CommandName.DialogChooseFolder]: emptyRequest,
  [CommandName.TasksList]: tasksListRequest,
  [CommandName.TasksListActive]: tasksListRequest,
  [CommandName.TasksListDone]: tasksListDoneRequest,
  [CommandName.TasksGet]: tasksGetRequest,
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
  [CommandName.ImagesGet]: imagesGetRequest,
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
  [CommandName.TerminalList]: emptyRequest,
  [CommandName.TerminalCreate]: terminalCreateRequest,
  [CommandName.TerminalDuplicate]: terminalIdRequest,
  [CommandName.TerminalAttach]: terminalSizeRequest,
  [CommandName.TerminalWrite]: terminalWriteRequest,
  [CommandName.TerminalResize]: terminalSizeRequest,
  [CommandName.TerminalRename]: terminalRenameRequest,
  [CommandName.TerminalClear]: terminalIdRequest,
  [CommandName.TerminalInterrupt]: terminalIdRequest,
  [CommandName.TerminalClose]: terminalIdRequest,
  [CommandName.MenuUpdate]: menuUpdateRequest,
  [CommandName.WindowClose]: emptyRequest,
  [CommandName.LogRendererError]: logRendererErrorRequest,
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
