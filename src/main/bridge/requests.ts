// Request schemas live on the main side only, so the renderer never bundles zod for them.
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import {
  CommandName,
  MAX_RENDERER_ERROR_TEXT,
  RendererErrorKind,
  type ArtifactsAddLinkRequest,
  type ArtifactsRemoveRequest,
  type ArtifactsSetFilterRequest,
  type ArtifactsSetGroupOpenRequest,
  type ArtifactsWatchRequest,
  type ClipboardWriteTextRequest,
  type LinksOpenRequest,
  type CommandRequest,
  type EmptyRequest,
  type FileRequest,
  type FilesWriteRequest,
  type FilesBrowseRequest,
  type FilesExpandedFoldersRequest,
  type FilesSearchRequest,
  type FilesSetFolderExpandedRequest,
  type FilesWatchFoldersRequest,
  type FolderRequest,
  type WindowSetUnsavedEditsRequest,
  type AttachmentsAddRequest,
  type AttachmentsDiscardRequest,
  type DraftsGetRequest,
  type DraftsSetRequest,
  type ImagesGetRequest,
  type PermissionsAnswerRequest,
  type LogRendererErrorRequest,
  type MenuBarFitRequest,
  type MenuUpdateRequest,
  type QueueAddRequest,
  type QueueEditRequest,
  type QueueRemoveRequest,
  type QuestionsAnswerRequest,
  type SearchQueryRequest,
  type SubagentsStopRequest,
  type WatchersStopRequest,
  type ChangesFilesRequest,
  type ChangesOpenFileRequest,
  type ChangesRepositoryRequest,
  type TaskIdRequest,
  type TasksGetRequest,
  type TasksListDoneRequest,
  type TerminalCreateRequest,
  type TerminalIdRequest,
  type TerminalRenameRequest,
  type TerminalSizeRequest,
  type TerminalWriteRequest,
  type WindowSetTrafficLightsRequest,
  type TasksCreateRequest,
  type TasksRetryRequest,
  type LoginStartRequest,
  type TasksBroadcastRequest,
  type TasksSendRequest,
  type TasksUpdateRequest,
  type TasksListRequest,
  type UiStateGetRequest,
  type UiStateSetRequest,
  type WorkspacesCreateRequest,
  type WorkspacesOpenRequest,
  type WorkspacesRemoveRequest,
  type SettingsUpdateRequest,
  type PluginsSetEnabledRequest,
  type PluginsSetCapabilityRequest,
  type PluginsSetSettingRequest,
  type PluginsPlaceViewRequest,
  type PluginsReloadRequest,
  type SandboxAddGrantRequest,
  type SandboxListGrantsRequest,
  type SandboxListReportedServersRequest,
  type SandboxRemoveGrantRequest,
  type SandboxSetFolderAccessRequest,
  type WorkspacesUpdateRequest,
  type WorkspacesRevealRequest,
  type TodoHubGetRequest,
  type TodoHubSetPanelRequest,
} from '../../shared/bridge'
import { AttachedFileKind, isAttachedFileName, isAttachedFileOf, type AttachedFile } from '../../shared/attachedFiles'
import { MAX_DONE_PAGE_SIZE } from '../../shared/doneList'
import {
  ArtifactDateGroup,
  ArtifactFilter,
  ArtifactKind,
  Effort,
  PermissionMode,
  UiStateKey,
  type PastedBlock,
} from '../../shared/domain'
import { isWorkspaceRelativePath, parseCommitFileKey } from '../../shared/files'
import { MAX_SEARCH_QUERY, MAX_WATCHED_FOLDERS } from '../../shared/browse'
import { MAX_MENU_BAR_HEIGHT } from '../../shared/menuBar'
import { hasImageSignature, ImageMediaType, MAX_IMAGE_BASE64_LENGTH, type ImageData } from '../../shared/images'
import { MAX_PASTED_BLOCK_LENGTH, PASTE_ID_PATTERN } from '../../shared/pastedContent'
import { PluginCapability } from '../../shared/plugins'
import { FolderAccess, OtherAgents, SandboxGrantKind, SandboxGrantScope } from '../../shared/sandbox'
import { MAX_TERMINAL_NAME, MAX_TERMINAL_SIZE, MAX_TERMINAL_WRITE } from '../../shared/terminal'
import { ChildFilter } from '../../shared/todoHub'
import { SETTING_SCHEMAS } from '../db/repositories/settings'
import { permissionDecisionSchema } from '../permissions/schema'
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
    permissionMode: z.enum(PermissionMode).optional(),
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

/** A block of text pasted into a message (#363): its id is what its inline token is matched to it by position. */
const pastedBlock = z.strictObject({
  id: z.string().regex(PASTE_ID_PATTERN),
  text: z.string().min(1).max(MAX_PASTED_BLOCK_LENGTH),
}) satisfies z.ZodType<PastedBlock>

/** A file attached to a message (#396), as `attachments.add` answered with its copy. */
const attachedFile = z.strictObject({
  name: z.string().refine(isAttachedFileName, 'Expected a file name'),
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  kind: z.enum(AttachedFileKind),
}) satisfies z.ZodType<AttachedFile>

/** What a message, queued message or draft carries besides its text. */
interface MessageContent {
  readonly text: string
  readonly images?: readonly ImageData[] | undefined
  readonly pastedBlocks?: readonly PastedBlock[] | undefined
  readonly files?: readonly AttachedFile[] | undefined
}

/** A request whose attached files are all the task's own copies, in its folder of them (`taskIdOf` names the task). */
function withOwnFiles<T extends MessageContent>(schema: z.ZodType<T>, taskIdOf: (request: T) => string): z.ZodType<T> {
  return schema.refine((request) => (request.files ?? []).every((file) => isAttachedFileOf(taskIdOf(request), file)), {
    message: "Expected the task's own attached files",
    path: ['files'],
  })
}

/**
 * A message's text, images, pasted blocks and attached files: its text can be blank only when it has images or files,
 * and its files are the task's own.
 */
function withContent<T extends MessageContent>(schema: z.ZodType<T>, taskIdOf: (request: T) => string): z.ZodType<T> {
  return withOwnFiles(
    schema.refine(({ text, images = [], files = [] }) => text.trim() !== '' || images.length > 0 || files.length > 0, {
      message: 'Expected a message that is not blank',
      path: ['text'],
    }),
    taskIdOf,
  )
}

const tasksSendRequest = withContent(
  z.strictObject({
    id: z.string(),
    text: z.string(),
    images: z.array(image).readonly().optional(),
    pastedBlocks: z.array(pastedBlock).readonly().optional(),
    files: z.array(attachedFile).readonly().optional(),
  }),
  ({ id }) => id,
) satisfies z.ZodType<TasksSendRequest>

const tasksBroadcastRequest = z.strictObject({ text: messageText }) satisfies z.ZodType<TasksBroadcastRequest>

const tasksRetryRequest = z.strictObject({
  id: z.string(),
  model: z.string().min(1).optional(),
}) satisfies z.ZodType<TasksRetryRequest>

const loginStartRequest = z.strictObject({
  taskId: z.string().nullable(),
}) satisfies z.ZodType<LoginStartRequest>

const subagentsStopRequest = z.strictObject({
  taskId: z.string(),
  toolUseId: z.string(),
}) satisfies z.ZodType<SubagentsStopRequest>

const watchersStopRequest = z.strictObject({
  taskId: z.string(),
  id: z.string(),
}) satisfies z.ZodType<WatchersStopRequest>

const queueAddRequest = withContent(
  z.strictObject({
    taskId: z.string(),
    text: z.string(),
    images: z.array(image).readonly().optional(),
    pastedBlocks: z.array(pastedBlock).readonly().optional(),
    files: z.array(attachedFile).readonly().optional(),
  }),
  ({ taskId }) => taskId,
) satisfies z.ZodType<QueueAddRequest>

const queueEditRequest = z.strictObject({ id: z.string(), text: messageText }) satisfies z.ZodType<QueueEditRequest>

const queueRemoveRequest = z.strictObject({ id: z.string() }) satisfies z.ZodType<QueueRemoveRequest>

const imagesGetRequest = z.strictObject({ id: z.string() }) satisfies z.ZodType<ImagesGetRequest>

const attachmentsAddRequest = z.strictObject({
  taskId: z.string(),
  path: absolutePath,
}) satisfies z.ZodType<AttachmentsAddRequest>

const attachmentsDiscardRequest = z.strictObject({
  taskId: z.string(),
  path: z.string().min(1),
}) satisfies z.ZodType<AttachmentsDiscardRequest>

const draftsGetRequest = z.strictObject({ taskId: z.string() }) satisfies z.ZodType<DraftsGetRequest>

/** A draft can be anything typed, blank included: an empty one is removed. Its files are the task's own. */
const draftsSetRequest = withOwnFiles(
  z.strictObject({
    taskId: z.string(),
    text: z.string(),
    images: z.array(image).readonly().optional(),
    pastedBlocks: z.array(pastedBlock).readonly().optional(),
    files: z.array(attachedFile).readonly().optional(),
  }),
  ({ taskId }) => taskId,
) satisfies z.ZodType<DraftsSetRequest>

const questionsAnswerRequest = z.strictObject({
  id: z.string(),
  answers: questionAnswersSchema,
  anythingElse: z.string().optional(),
}) satisfies z.ZodType<QuestionsAnswerRequest>

const permissionsAnswerRequest = z.strictObject({
  id: z.string(),
  decision: permissionDecisionSchema,
}) satisfies z.ZodType<PermissionsAnswerRequest>

const fileRequest = z.strictObject({
  taskId: z.string(),
  path: z
    .string()
    .refine(isWorkspaceRelativePath, 'Expected a normalized path relative to the workspace root, inside it'),
}) satisfies z.ZodType<FileRequest>

const windowSetUnsavedEditsRequest = z.strictObject({
  unsaved: z.boolean(),
}) satisfies z.ZodType<WindowSetUnsavedEditsRequest>

/** A file of the workspace to save: never a commit's, which is only in git. */
const filesWriteRequest = z.strictObject({
  taskId: z.string(),
  path: z
    .string()
    .refine(isWorkspaceRelativePath, 'Expected a normalized path relative to the workspace root, inside it'),
  text: z.string(),
}) satisfies z.ZodType<FilesWriteRequest>

/** A file the Files tab can have open: one in the workspace, or one as a commit left it (its commit file key). */
const openFileRequest = z.strictObject({
  taskId: z.string(),
  path: z
    .string()
    .refine(
      (path) => isWorkspaceRelativePath(path) || parseCommitFileKey(path) !== null,
      'Expected a normalized path relative to the workspace root, inside it, or a commit file key',
    ),
}) satisfies z.ZodType<FileRequest>

/** A folder of the workspace for the Browse tab: the root (`''`), or a path relative to it, inside it. */
const folderPath = z
  .string()
  .refine((path) => path === '' || isWorkspaceRelativePath(path), 'Expected the root, or a normalized path inside it')

const folderRequest = z.strictObject({ taskId: z.string(), path: folderPath }) satisfies z.ZodType<FolderRequest>

const filesBrowseRequest = z.strictObject({ taskId: z.string() }) satisfies z.ZodType<FilesBrowseRequest>

const filesSearchRequest = z.strictObject({
  taskId: z.string(),
  query: z.string().max(MAX_SEARCH_QUERY),
}) satisfies z.ZodType<FilesSearchRequest>

const filesExpandedFoldersRequest = z.strictObject({
  taskId: z.string(),
}) satisfies z.ZodType<FilesExpandedFoldersRequest>

const filesSetFolderExpandedRequest = z.strictObject({
  taskId: z.string(),
  path: z
    .string()
    .refine(isWorkspaceRelativePath, 'Expected a normalized path relative to the workspace root, inside it'),
  expanded: z.boolean(),
}) satisfies z.ZodType<FilesSetFolderExpandedRequest>

const filesWatchFoldersRequest = z.strictObject({
  taskId: z.string(),
  paths: z.array(folderPath).max(MAX_WATCHED_FOLDERS).readonly(),
}) satisfies z.ZodType<FilesWatchFoldersRequest>

const changesFilesRequest = z.strictObject({
  taskId: z.string(),
  id: z.string(),
}) satisfies z.ZodType<ChangesFilesRequest>

const changesOpenFileRequest = z.strictObject({
  taskId: z.string(),
  id: z.string(),
  path: z.string().refine(isWorkspaceRelativePath, 'Expected a normalized path relative to the repository'),
}) satisfies z.ZodType<ChangesOpenFileRequest>

const changesRepositoryRequest = z.strictObject({ taskId: z.string() }) satisfies z.ZodType<ChangesRepositoryRequest>

const settingsUpdateRequest = z.strictObject({
  patch: z.strictObject(SETTING_SCHEMAS).partial(),
}) satisfies z.ZodType<SettingsUpdateRequest>
const artifactsRemoveRequest = z.strictObject({
  taskId: z.string(),
  ref: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal(ArtifactKind.File), path: z.string() }),
    z.strictObject({ kind: z.literal(ArtifactKind.Link), url: z.string() }),
  ]),
}) satisfies z.ZodType<ArtifactsRemoveRequest>

const artifactsAddLinkRequest = z.strictObject({
  taskId: z.string(),
  url: z.string(),
  text: z.string(),
}) satisfies z.ZodType<ArtifactsAddLinkRequest>

const artifactsSetFilterRequest = z.strictObject({
  taskId: z.string(),
  filter: z.enum(ArtifactFilter),
}) satisfies z.ZodType<ArtifactsSetFilterRequest>

const artifactsSetGroupOpenRequest = z.strictObject({
  taskId: z.string(),
  group: z.enum(ArtifactDateGroup),
  open: z.boolean(),
}) satisfies z.ZodType<ArtifactsSetGroupOpenRequest>

const artifactsWatchRequest = z.strictObject({ taskId: z.string() }) satisfies z.ZodType<ArtifactsWatchRequest>

const todoHubGetRequest = z.strictObject({ taskId: z.string() }) satisfies z.ZodType<TodoHubGetRequest>

const todoHubSetPanelRequest = z.strictObject({
  taskId: z.string(),
  todoId: z.string().min(1),
  open: z.boolean(),
  filter: z.enum(ChildFilter),
}) satisfies z.ZodType<TodoHubSetPanelRequest>

const pluginsSetEnabledRequest = z.strictObject({
  id: z.string(),
  enabled: z.boolean(),
}) satisfies z.ZodType<PluginsSetEnabledRequest>

const pluginsSetCapabilityRequest = z.strictObject({
  id: z.string(),
  capability: z.enum(PluginCapability),
  granted: z.boolean(),
}) satisfies z.ZodType<PluginsSetCapabilityRequest>

const pluginsSetSettingRequest = z.strictObject({
  id: z.string(),
  key: z.string(),
  value: z.string(),
}) satisfies z.ZodType<PluginsSetSettingRequest>

const windowSetTrafficLightsRequest = z.strictObject({
  collapsed: z.boolean(),
}) satisfies z.ZodType<WindowSetTrafficLightsRequest>

/** The largest a plugin view's side or offset can be, in CSS pixels: far bigger than any screen. */
const MAX_VIEW_PIXELS = 100_000

/** A plugin view's place in the window, in CSS pixels: whole or fractional, as `getBoundingClientRect` gives them. */
const viewBounds = z.strictObject({
  x: z.number().min(-MAX_VIEW_PIXELS).max(MAX_VIEW_PIXELS),
  y: z.number().min(-MAX_VIEW_PIXELS).max(MAX_VIEW_PIXELS),
  width: z.number().min(0).max(MAX_VIEW_PIXELS),
  height: z.number().min(0).max(MAX_VIEW_PIXELS),
})

const pluginsPlaceViewRequest = z.strictObject({
  id: z.string(),
  bounds: viewBounds.nullable(),
}) satisfies z.ZodType<PluginsPlaceViewRequest>

const pluginsReloadRequest = z.strictObject({ id: z.string() }) satisfies z.ZodType<PluginsReloadRequest>

/** A scope Settings lists: Glade-wide, or a workspace's. A task's grants aren't Settings', so its scope doesn't parse. */
const settingsGrantTarget = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal(SandboxGrantScope.Glade) }),
  z.strictObject({ scope: z.literal(SandboxGrantScope.Workspace), workspaceId: z.string() }),
])

const sandboxListGrantsRequest = z.strictObject({
  target: settingsGrantTarget,
}) satisfies z.ZodType<SandboxListGrantsRequest>

const sandboxAddGrantRequest = z.strictObject({
  target: settingsGrantTarget,
  grant: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal(SandboxGrantKind.Folder), path: z.string(), access: z.enum(FolderAccess) }),
    z.strictObject({ kind: z.literal(SandboxGrantKind.Domain), domain: z.string() }),
    z.strictObject({ kind: z.literal(SandboxGrantKind.McpServer), server: z.string(), name: z.string() }),
    z.strictObject({ kind: z.literal(SandboxGrantKind.Agents), agents: z.enum(OtherAgents) }),
  ]),
}) satisfies z.ZodType<SandboxAddGrantRequest>

const sandboxSetFolderAccessRequest = z.strictObject({
  target: settingsGrantTarget,
  path: z.string(),
  access: z.enum(FolderAccess),
}) satisfies z.ZodType<SandboxSetFolderAccessRequest>

const sandboxRemoveGrantRequest = z.strictObject({
  target: settingsGrantTarget,
  grant: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal(SandboxGrantKind.Folder), path: z.string() }),
    z.strictObject({ kind: z.literal(SandboxGrantKind.Domain), domain: z.string() }),
    z.strictObject({ kind: z.literal(SandboxGrantKind.McpServer), server: z.string() }),
    z.strictObject({ kind: z.literal(SandboxGrantKind.Agents), agents: z.enum(OtherAgents) }),
  ]),
}) satisfies z.ZodType<SandboxRemoveGrantRequest>

const sandboxListReportedServersRequest = z.strictObject({
  target: settingsGrantTarget,
}) satisfies z.ZodType<SandboxListReportedServersRequest>

const clipboardWriteTextRequest = z.strictObject({ text: z.string() }) satisfies z.ZodType<ClipboardWriteTextRequest>

// Which schemes open is main's to check, when it opens the link (`../links/links`), so a refused one is logged.
const linksOpenRequest = z.strictObject({ url: z.string() }) satisfies z.ZodType<LinksOpenRequest>

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

/** The popover's content height: a whole number of CSS pixels, from nothing up to a screen's worth. */
const menuBarFitRequest = z.strictObject({
  height: z.number().nonnegative().max(MAX_MENU_BAR_HEIGHT),
}) satisfies z.ZodType<MenuBarFitRequest>

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
  [CommandName.TasksBroadcast]: tasksBroadcastRequest,
  [CommandName.TasksStop]: taskIdRequest,
  [CommandName.TasksRetry]: tasksRetryRequest,
  [CommandName.TasksRetryLoggedOut]: emptyRequest,
  [CommandName.TasksCompact]: taskIdRequest,
  [CommandName.SubagentsStop]: subagentsStopRequest,
  [CommandName.SubagentsListRunning]: emptyRequest,
  [CommandName.WatchersListLive]: emptyRequest,
  [CommandName.WatchersStop]: watchersStopRequest,
  [CommandName.ChangesFiles]: changesFilesRequest,
  [CommandName.ChangesOpenFile]: changesOpenFileRequest,
  [CommandName.ChangesRepository]: changesRepositoryRequest,
  [CommandName.TasksHistory]: taskIdRequest,
  [CommandName.QueueAdd]: queueAddRequest,
  [CommandName.QueueEdit]: queueEditRequest,
  [CommandName.QueueRemove]: queueRemoveRequest,
  [CommandName.ImagesGet]: imagesGetRequest,
  [CommandName.AttachmentsAdd]: attachmentsAddRequest,
  [CommandName.AttachmentsDiscard]: attachmentsDiscardRequest,
  [CommandName.DraftsGet]: draftsGetRequest,
  [CommandName.DraftsSet]: draftsSetRequest,
  [CommandName.QuestionsAnswer]: questionsAnswerRequest,
  [CommandName.PermissionsAnswer]: permissionsAnswerRequest,
  [CommandName.FilesRead]: openFileRequest,
  [CommandName.FilesWrite]: filesWriteRequest,
  [CommandName.FilesOpen]: openFileRequest,
  [CommandName.FilesClose]: openFileRequest,
  [CommandName.FilesOpenInEditor]: fileRequest,
  [CommandName.ClipboardWriteText]: clipboardWriteTextRequest,
  [CommandName.LinksOpen]: linksOpenRequest,
  [CommandName.FilesThumbnail]: fileRequest,
  [CommandName.FilesCopy]: fileRequest,
  [CommandName.FilesReveal]: fileRequest,
  [CommandName.FilesBrowse]: filesBrowseRequest,
  [CommandName.FilesListFolder]: folderRequest,
  [CommandName.FilesSearch]: filesSearchRequest,
  [CommandName.FilesExpandedFolders]: filesExpandedFoldersRequest,
  [CommandName.FilesSetFolderExpanded]: filesSetFolderExpandedRequest,
  [CommandName.FilesWatchFolders]: filesWatchFoldersRequest,
  [CommandName.ArtifactsRemove]: artifactsRemoveRequest,
  [CommandName.ArtifactsAddLink]: artifactsAddLinkRequest,
  [CommandName.ArtifactsSetFilter]: artifactsSetFilterRequest,
  [CommandName.ArtifactsSetGroupOpen]: artifactsSetGroupOpenRequest,
  [CommandName.ArtifactsWatch]: artifactsWatchRequest,
  [CommandName.ArtifactsUnwatch]: artifactsWatchRequest,
  [CommandName.TodoHubGet]: todoHubGetRequest,
  [CommandName.TodoHubSetPanel]: todoHubSetPanelRequest,
  [CommandName.UiStateGet]: uiStateGetRequest,
  [CommandName.UiStateGetAll]: emptyRequest,
  [CommandName.UiStateSet]: uiStateSetRequest,
  [CommandName.SettingsGet]: emptyRequest,
  [CommandName.ModelsList]: emptyRequest,
  [CommandName.SettingsUpdate]: settingsUpdateRequest,
  [CommandName.SearchQuery]: searchQueryRequest,
  [CommandName.PluginsList]: emptyRequest,
  [CommandName.ControlStatus]: emptyRequest,
  [CommandName.AccountStatus]: emptyRequest,
  [CommandName.LoginStatus]: emptyRequest,
  [CommandName.LoginStart]: loginStartRequest,
  [CommandName.LoginCancel]: emptyRequest,
  [CommandName.ControlRegenerateToken]: emptyRequest,
  [CommandName.PluginsSetEnabled]: pluginsSetEnabledRequest,
  [CommandName.PluginsSetCapability]: pluginsSetCapabilityRequest,
  [CommandName.PluginsSetSetting]: pluginsSetSettingRequest,
  [CommandName.PluginsOpenFolder]: emptyRequest,
  [CommandName.PluginsPlaceView]: pluginsPlaceViewRequest,
  [CommandName.PluginsReload]: pluginsReloadRequest,
  [CommandName.SandboxListGrants]: sandboxListGrantsRequest,
  [CommandName.SandboxAddGrant]: sandboxAddGrantRequest,
  [CommandName.SandboxSetFolderAccess]: sandboxSetFolderAccessRequest,
  [CommandName.SandboxRemoveGrant]: sandboxRemoveGrantRequest,
  [CommandName.SandboxListReportedServers]: sandboxListReportedServersRequest,
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
  [CommandName.WindowSetTrafficLights]: windowSetTrafficLightsRequest,
  [CommandName.AppQuit]: emptyRequest,
  [CommandName.WindowSetUnsavedEdits]: windowSetUnsavedEditsRequest,
  [CommandName.LogRendererError]: logRendererErrorRequest,
  [CommandName.MenuBarGet]: emptyRequest,
  [CommandName.MenuBarOpenTask]: taskIdRequest,
  [CommandName.MenuBarOpenGlade]: emptyRequest,
  [CommandName.MenuBarHide]: emptyRequest,
  [CommandName.MenuBarQuit]: emptyRequest,
  [CommandName.MenuBarFit]: menuBarFitRequest,
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
