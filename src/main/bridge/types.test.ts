// Type-level checks, enforced by `npm run typecheck` (this file is in tsconfig.node.json): the command map is the one
// source of truth, so a request or response that disagrees with it on either side of the bridge fails the typecheck.
// Each `@ts-expect-error` fails the typecheck if its line stops being an error.
import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import {
  CommandName,
  EventType,
  type CommandRequest,
  type CommandResponse,
  type GladeBridge,
  type GladeEvent,
} from '../../shared/bridge'
import type { Command } from '../../shared/commands'
import {
  Effort,
  FileContentKind,
  FileInfoKind,
  PermissionDecisionKind,
  TaskState,
  UiStateKey,
  type Message,
  type Artifact,
  type OpenFiles,
  type PermissionRequest,
  type QuestionSet,
  type TodoList,
  type QueuedMessage,
  type Task,
  type ToolEvent,
  type UiStateEntry,
  type Workspace,
} from '../../shared/domain'
import { ImageMediaType } from '../../shared/images'
import type { TerminalTab } from '../../shared/terminal'
import type { InstalledPlugin } from '../../shared/plugins'
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings'
import type { Handlers } from './handlers'
import { DEFAULT_CONTROL_PORT, type ControlStatus } from '../../shared/control'
import { REQUEST_SCHEMAS, type RequestSchemas } from './requests'


const CONTROL_STATUS: ControlStatus = {
  enabled: false,
  chosenPort: DEFAULT_CONTROL_PORT,
  port: null,
  url: null,
  token: null,
  error: null,
}
const noop = (...values: unknown[]): unknown[] => values
/** A stand-in: these tests are about types, so what it answers doesn't matter. */
const glade: GladeBridge = { invoke: () => Promise.resolve({} as never), subscribe: () => noop }
const WORKSPACE: Workspace = { id: 'w', name: 'Acme API', rootPath: '/code/acme-api', createdAt: 1, lastOpenedAt: 1 }

// The task commands' handlers and schemas, right, so each registry below differs from a valid one in one way only.
const TASK_HANDLERS = {
  [CommandName.TasksListActive]: () => ({ tasks: [], done: { all: 0, unread: 0 } }),
  [CommandName.TasksListDone]: () => ({ tasks: [], hasMore: false }),
  [CommandName.TasksGet]: () => ({ tasks: [] }),
  [CommandName.TasksCreate]: () => ({ task: {} as Task }),
  [CommandName.TasksMarkDone]: () => ({ task: {} as Task }),
  [CommandName.TasksReopen]: () => ({ task: {} as Task }),
  [CommandName.TasksUpdate]: () => ({ task: {} as Task }),
  [CommandName.TasksDelete]: () => null,
  [CommandName.TasksSend]: () => ({ message: {} as Message }),
  [CommandName.TasksStop]: () => ({ task: {} as Task }),
  [CommandName.TasksRetry]: () => ({ task: {} as Task }),
  [CommandName.TasksCompact]: () => ({ task: {} as Task }),
  [CommandName.TasksHistory]: () => ({
    messages: [],
    toolEvents: [],
    queuedMessages: [],
    questionSets: [],
    permissionRequests: [],
    openFiles: { taskId: 't', paths: [], activePath: null },
    todos: null,
    artifacts: [],
  }),
  [CommandName.QueueAdd]: () => ({ queuedMessage: {} as QueuedMessage }),
  [CommandName.QueueEdit]: () => ({ queuedMessage: {} as QueuedMessage }),
  [CommandName.QueueRemove]: () => null,
  [CommandName.ImagesGet]: () => ({ image: { mediaType: ImageMediaType.Png, data: '' } }),
  [CommandName.QuestionsAnswer]: () => ({ questionSet: {} as QuestionSet }),
  [CommandName.PermissionsAnswer]: () => ({ permissionRequest: {} as PermissionRequest }),
  [CommandName.FilesRead]: () => ({ content: { kind: FileContentKind.Missing } }),
  [CommandName.FilesOpen]: () => ({ openFiles: {} as OpenFiles }),
  [CommandName.FilesClose]: () => ({ openFiles: {} as OpenFiles }),
  [CommandName.FilesOpenInEditor]: () => null,
  [CommandName.SubagentsStop]: () => null,
  [CommandName.ClipboardWriteText]: () => null,
  [CommandName.FilesInfo]: () => ({ info: { kind: FileInfoKind.Missing } }),
  [CommandName.FilesCopy]: () => null,
  [CommandName.FilesReveal]: () => null,
  [CommandName.WorkspacesUpdate]: () => ({ workspace: WORKSPACE }),
  [CommandName.SettingsGet]: () => ({ settings: DEFAULT_SETTINGS }),
  [CommandName.SettingsUpdate]: () => ({ settings: DEFAULT_SETTINGS }),
  [CommandName.ArtifactsRemove]: () => null,
  [CommandName.WorkspacesRemove]: () => null,
  [CommandName.MenuUpdate]: () => null,
  [CommandName.WindowClose]: () => null,
  [CommandName.LogRendererError]: () => null,
  [CommandName.SearchQuery]: () => ({ results: [] }),
  [CommandName.TerminalList]: () => ({ tabs: [] }),
  [CommandName.TerminalCreate]: () => ({ tab: {} as TerminalTab }),
  [CommandName.TerminalDuplicate]: () => ({ tab: {} as TerminalTab }),
  [CommandName.TerminalAttach]: () => ({ output: '', end: 0 }),
  [CommandName.TerminalWrite]: () => null,
  [CommandName.TerminalResize]: () => null,
  [CommandName.TerminalRename]: () => null,
  [CommandName.TerminalClear]: () => null,
  [CommandName.TerminalInterrupt]: () => null,
  [CommandName.TerminalClose]: () => null,
  [CommandName.PluginsList]: () => ({ plugins: [] }),
  [CommandName.PluginsSetEnabled]: () => ({ plugins: [] }),
  [CommandName.PluginsOpenFolder]: () => null,
  [CommandName.PluginsPlaceView]: () => ({ status: '' }),
  [CommandName.ControlStatus]: () => ({ status: CONTROL_STATUS }),
  [CommandName.ControlRegenerateToken]: () => ({ status: CONTROL_STATUS }),
} satisfies Partial<Handlers>
const TASK_SCHEMAS = {
  [CommandName.TasksCreate]: REQUEST_SCHEMAS[CommandName.TasksCreate],
  [CommandName.TasksMarkDone]: REQUEST_SCHEMAS[CommandName.TasksMarkDone],
  [CommandName.TasksReopen]: REQUEST_SCHEMAS[CommandName.TasksReopen],
  [CommandName.TasksUpdate]: REQUEST_SCHEMAS[CommandName.TasksUpdate],
  [CommandName.TasksSend]: REQUEST_SCHEMAS[CommandName.TasksSend],
  [CommandName.TasksStop]: REQUEST_SCHEMAS[CommandName.TasksStop],
  [CommandName.TasksRetry]: REQUEST_SCHEMAS[CommandName.TasksRetry],
  [CommandName.TasksCompact]: REQUEST_SCHEMAS[CommandName.TasksCompact],
  [CommandName.TasksHistory]: REQUEST_SCHEMAS[CommandName.TasksHistory],
  [CommandName.QueueAdd]: REQUEST_SCHEMAS[CommandName.QueueAdd],
  [CommandName.QueueEdit]: REQUEST_SCHEMAS[CommandName.QueueEdit],
  [CommandName.QueueRemove]: REQUEST_SCHEMAS[CommandName.QueueRemove],
  [CommandName.ImagesGet]: REQUEST_SCHEMAS[CommandName.ImagesGet],
  [CommandName.QuestionsAnswer]: REQUEST_SCHEMAS[CommandName.QuestionsAnswer],
  [CommandName.PermissionsAnswer]: REQUEST_SCHEMAS[CommandName.PermissionsAnswer],
  [CommandName.FilesRead]: REQUEST_SCHEMAS[CommandName.FilesRead],
  [CommandName.FilesOpen]: REQUEST_SCHEMAS[CommandName.FilesOpen],
  [CommandName.FilesClose]: REQUEST_SCHEMAS[CommandName.FilesClose],
  [CommandName.FilesOpenInEditor]: REQUEST_SCHEMAS[CommandName.FilesOpenInEditor],
  [CommandName.SubagentsStop]: REQUEST_SCHEMAS[CommandName.SubagentsStop],
  [CommandName.ClipboardWriteText]: REQUEST_SCHEMAS[CommandName.ClipboardWriteText],
  [CommandName.FilesInfo]: REQUEST_SCHEMAS[CommandName.FilesInfo],
  [CommandName.FilesCopy]: REQUEST_SCHEMAS[CommandName.FilesCopy],
  [CommandName.FilesReveal]: REQUEST_SCHEMAS[CommandName.FilesReveal],
  [CommandName.WorkspacesUpdate]: REQUEST_SCHEMAS[CommandName.WorkspacesUpdate],
  [CommandName.SettingsGet]: REQUEST_SCHEMAS[CommandName.SettingsGet],
  [CommandName.SettingsUpdate]: REQUEST_SCHEMAS[CommandName.SettingsUpdate],
  [CommandName.ArtifactsRemove]: REQUEST_SCHEMAS[CommandName.ArtifactsRemove],
  [CommandName.SearchQuery]: REQUEST_SCHEMAS[CommandName.SearchQuery],
  [CommandName.WorkspacesRemove]: REQUEST_SCHEMAS[CommandName.WorkspacesRemove],
  [CommandName.MenuUpdate]: REQUEST_SCHEMAS[CommandName.MenuUpdate],
  [CommandName.WindowClose]: REQUEST_SCHEMAS[CommandName.WindowClose],
  [CommandName.LogRendererError]: REQUEST_SCHEMAS[CommandName.LogRendererError],
} satisfies Partial<RequestSchemas>

describe('the command map', () => {
  it('types invoke from the map: its request and its response', () => {
    expectTypeOf(glade.invoke(CommandName.WorkspacesList, {})).resolves.toEqualTypeOf<{
      readonly workspaces: readonly Workspace[]
    }>()
    expectTypeOf(glade.invoke(CommandName.UiStateGet, { key: UiStateKey.ActiveWorkspaceId })).resolves.toEqualTypeOf<{
      readonly value: string | null
    }>()
    expectTypeOf(glade.invoke(CommandName.TasksList, { workspaceId: 'w' })).resolves.toEqualTypeOf<{
      readonly tasks: readonly Task[]
    }>()
    expectTypeOf(glade.invoke(CommandName.WorkspacesCreate, { rootPath: '/code/acme-api' })).resolves.toEqualTypeOf<{
      readonly workspace: Workspace
      readonly created: boolean
    }>()
    expectTypeOf(glade.invoke(CommandName.WorkspacesOpen, { id: 'w' })).resolves.toEqualTypeOf<{
      readonly workspace: Workspace
      readonly selectedTaskId: string | null
    }>()
    expectTypeOf(glade.invoke(CommandName.WorkspacesReveal, { id: 'w' })).resolves.toEqualTypeOf<null>()
    expectTypeOf(glade.invoke(CommandName.DialogChooseFolder, {})).resolves.toEqualTypeOf<{
      readonly path: string | null
    }>()
    expectTypeOf(glade.invoke(CommandName.UiStateGetAll, {})).resolves.toEqualTypeOf<{
      readonly entries: readonly UiStateEntry[]
    }>()
    expectTypeOf(glade.invoke(CommandName.TasksCreate, { workspaceId: 'w' })).resolves.toEqualTypeOf<{
      readonly task: Task
    }>()
    expectTypeOf(glade.invoke(CommandName.TasksMarkDone, { id: 't' })).resolves.toEqualTypeOf<{ readonly task: Task }>()
    expectTypeOf(glade.invoke(CommandName.TasksReopen, { id: 't' })).resolves.toEqualTypeOf<{ readonly task: Task }>()
    expectTypeOf(
      glade.invoke(CommandName.TasksUpdate, { id: 't', patch: { pinned: true, effort: Effort.Low } }),
    ).resolves.toEqualTypeOf<{ readonly task: Task }>()
    expectTypeOf(glade.invoke(CommandName.TasksSend, { id: 't', text: 'Hi' })).resolves.toEqualTypeOf<{
      readonly message: Message
    }>()
    expectTypeOf(glade.invoke(CommandName.TasksHistory, { id: 't' })).resolves.toEqualTypeOf<{
      readonly messages: readonly Message[]
      readonly toolEvents: readonly ToolEvent[]
      readonly queuedMessages: readonly QueuedMessage[]
      readonly questionSets: readonly QuestionSet[]
      readonly permissionRequests: readonly PermissionRequest[]
      readonly openFiles: OpenFiles
      readonly todos: TodoList | null
      readonly artifacts: readonly Artifact[]
    }>()
    expectTypeOf(glade.invoke(CommandName.QueueAdd, { taskId: 't', text: 'Hi' })).resolves.toEqualTypeOf<{
      readonly queuedMessage: QueuedMessage
    }>()
    expectTypeOf(glade.invoke(CommandName.QueueEdit, { id: 'q', text: 'Hi' })).resolves.toEqualTypeOf<{
      readonly queuedMessage: QueuedMessage
    }>()
    expectTypeOf(glade.invoke(CommandName.QueueRemove, { id: 'q' })).resolves.toBeNull()
    expectTypeOf(
      glade.invoke(CommandName.QuestionsAnswer, { id: 's', answers: { 0: 'by-type' } }),
    ).resolves.toEqualTypeOf<{
      readonly questionSet: QuestionSet
    }>()
    expectTypeOf(
      glade.invoke(CommandName.PermissionsAnswer, { id: 'p', decision: { kind: PermissionDecisionKind.AllowOnce } }),
    ).resolves.toEqualTypeOf<{
      readonly permissionRequest: PermissionRequest
    }>()
    expectTypeOf<CommandRequest<CommandName.UiStateSet>>().toEqualTypeOf<UiStateEntry>()
    expectTypeOf(
      glade.invoke(CommandName.UiStateSet, { key: UiStateKey.ActiveWorkspaceId, value: '' }),
    ).resolves.toBeNull()
  })

  it('refuses a renderer call whose request disagrees with the map', () => {
    // @ts-expect-error: the key must be a UiStateKey.
    void glade.invoke(CommandName.UiStateGet, { key: 'theme' })
    // @ts-expect-error: uiState.set needs a value.
    void glade.invoke(CommandName.UiStateSet, { key: UiStateKey.ActiveWorkspaceId })
    // @ts-expect-error: tasks.list needs a workspace id.
    void glade.invoke(CommandName.TasksList, {})
    // @ts-expect-error: uiState.getAll takes no arguments.
    void glade.invoke(CommandName.UiStateGetAll, { key: UiStateKey.ActiveWorkspaceId })
    // @ts-expect-error: workspaces.list takes no arguments.
    void glade.invoke(CommandName.WorkspacesList, { all: true })
    // @ts-expect-error: workspaces.create needs a root path.
    void glade.invoke(CommandName.WorkspacesCreate, {})
    // @ts-expect-error: workspaces.open takes the workspace's id, not its root.
    void glade.invoke(CommandName.WorkspacesOpen, { rootPath: '/code/acme-api' })
    // @ts-expect-error: tasks.create needs a workspace id.
    void glade.invoke(CommandName.TasksCreate, {})
    // @ts-expect-error: tasks.markDone needs a task id.
    void glade.invoke(CommandName.TasksMarkDone, {})
    // @ts-expect-error: the state changes only through tasks.markDone and tasks.reopen.
    void glade.invoke(CommandName.TasksUpdate, { id: 't', patch: { state: TaskState.Done } })
    // @ts-expect-error: the agent sets the status, through main's task service.
    void glade.invoke(CommandName.TasksUpdate, { id: 't', patch: { status: 'Done' } })
    // @ts-expect-error: the effort must be an Effort.
    void glade.invoke(CommandName.TasksUpdate, { id: 't', patch: { effort: 'huge' } })
    // @ts-expect-error: tasks.send needs the message's text.
    void glade.invoke(CommandName.TasksSend, { id: 't' })
    // @ts-expect-error: not a command.
    void glade.invoke('tasks.explode', {})
  })

  it('refuses a renderer that reads a response field the map does not have', async () => {
    const { value } = await glade.invoke(CommandName.UiStateGet, { key: UiStateKey.ActiveWorkspaceId })
    expectTypeOf(value).toEqualTypeOf<string | null>()
    // @ts-expect-error: uiState.get answers with `value`, not `workspaces`.
    const { workspaces } = await glade.invoke(CommandName.UiStateGet, { key: UiStateKey.ActiveWorkspaceId })
    noop(workspaces)
  })

  it('refuses a schema registry missing a command, or a schema that disagrees with the map', () => {
    // @ts-expect-error: uiState.set has no schema.
    const missing: RequestSchemas = {
      ...TASK_SCHEMAS,
      [CommandName.WorkspacesList]: z.strictObject({}),
      [CommandName.WorkspacesCreate]: z.strictObject({ rootPath: z.string() }),
      [CommandName.WorkspacesOpen]: z.strictObject({ id: z.string() }),
      [CommandName.DialogChooseFolder]: z.strictObject({}),
      [CommandName.TasksList]: z.strictObject({ workspaceId: z.string() }),
      [CommandName.UiStateGet]: z.strictObject({ key: z.enum(UiStateKey) }),
      [CommandName.UiStateGetAll]: z.strictObject({}),
    }
    const wrong: RequestSchemas = {
      ...TASK_SCHEMAS,
      [CommandName.WorkspacesList]: z.strictObject({}),
      [CommandName.WorkspacesCreate]: z.strictObject({ rootPath: z.string() }),
      [CommandName.WorkspacesOpen]: z.strictObject({ id: z.string() }),
      [CommandName.DialogChooseFolder]: z.strictObject({}),
      [CommandName.TasksList]: z.strictObject({ workspaceId: z.string() }),
      [CommandName.UiStateGetAll]: z.strictObject({}),
      // @ts-expect-error: uiState.get's key is a UiStateKey, not any string.
      [CommandName.UiStateGet]: z.strictObject({ key: z.string() }),
      [CommandName.UiStateSet]: z.strictObject({ key: z.enum(UiStateKey), value: z.string() }),
    }
    noop(missing, wrong)
  })

  it('refuses a handler registry missing a command', () => {
    // @ts-expect-error: uiState.set has no handler.
    const handlers: Handlers = {
      ...TASK_HANDLERS,
      [CommandName.WorkspacesList]: () => ({ workspaces: [] }),
      [CommandName.WorkspacesCreate]: () => ({ workspace: WORKSPACE, created: true }),
      [CommandName.WorkspacesOpen]: () => ({ workspace: WORKSPACE, selectedTaskId: null }),
      [CommandName.WorkspacesReveal]: () => null,
      [CommandName.DialogChooseFolder]: () => ({ path: null }),
      [CommandName.TasksList]: () => ({ tasks: [] }),
      [CommandName.UiStateGet]: () => ({ value: null }),
      [CommandName.UiStateGetAll]: () => ({ entries: [] }),
    }
    noop(handlers)
  })

  it('refuses a handler whose response disagrees with the map', () => {
    const handlers: Handlers = {
      ...TASK_HANDLERS,
      [CommandName.WorkspacesList]: () => ({ workspaces: [] }),
      [CommandName.WorkspacesCreate]: () => ({ workspace: WORKSPACE, created: true }),
      [CommandName.WorkspacesOpen]: () => ({ workspace: WORKSPACE, selectedTaskId: null }),
      [CommandName.WorkspacesReveal]: () => null,
      [CommandName.DialogChooseFolder]: () => ({ path: null }),
      [CommandName.TasksList]: () => ({ tasks: [] }),
      [CommandName.UiStateGetAll]: () => ({ entries: [] }),
      // @ts-expect-error: uiState.get answers `{ value }`, not a bare string.
      [CommandName.UiStateGet]: () => 'workspace-1',
      [CommandName.UiStateSet]: () => null,
    }
    noop(handlers)
  })

  it('refuses a handler that reads a request field the map does not have', () => {
    const handlers: Handlers = {
      ...TASK_HANDLERS,
      [CommandName.WorkspacesList]: () => ({ workspaces: [] }),
      [CommandName.WorkspacesCreate]: () => ({ workspace: WORKSPACE, created: true }),
      [CommandName.WorkspacesOpen]: () => ({ workspace: WORKSPACE, selectedTaskId: null }),
      [CommandName.WorkspacesReveal]: () => null,
      [CommandName.DialogChooseFolder]: () => ({ path: null }),
      [CommandName.TasksList]: () => ({ tasks: [] }),
      [CommandName.UiStateGetAll]: () => ({ entries: [] }),
      // @ts-expect-error: uiState.get's request has `key`, not `name`.
      [CommandName.UiStateGet]: ({ name }) => ({ value: String(name) }),
      [CommandName.UiStateSet]: () => null,
    }
    noop(handlers)
  })

  it('has a request schema for every command that parses to exactly its request interface', () => {
    // Each schema's output and its request interface are assignable both ways: no field missing, none extra.
    type Matches<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
    type SchemaMatches = {
      [C in CommandName]: Matches<z.output<(typeof REQUEST_SCHEMAS)[C]>, CommandRequest<C>>
    }
    expectTypeOf<SchemaMatches[CommandName]>().toEqualTypeOf<true>()
    expectTypeOf<keyof typeof REQUEST_SCHEMAS>().toEqualTypeOf<CommandName>()
    expectTypeOf<keyof Handlers>().toEqualTypeOf<CommandName>()
    expectTypeOf<Awaited<ReturnType<Handlers[CommandName.UiStateGet]>>>().toEqualTypeOf<
      CommandResponse<CommandName.UiStateGet>
    >()
  })
})

describe('events', () => {
  it('narrows an event by its type', () => {
    glade.subscribe((event) => {
      expectTypeOf(event).toEqualTypeOf<GladeEvent>()
      switch (event.type) {
        case EventType.UiStateChanged:
          expectTypeOf(event.entry).toEqualTypeOf<UiStateEntry>()
          break
        case EventType.WorkspaceUpdated:
          expectTypeOf(event.workspace).toEqualTypeOf<Workspace>()
          break
        case EventType.TaskUpdated:
          expectTypeOf(event.task).toEqualTypeOf<Task>()
          break
        case EventType.MessageAppended:
          expectTypeOf(event.message).toEqualTypeOf<Message>()
          break
        case EventType.ToolEventAppended:
        case EventType.ToolEventUpdated:
          expectTypeOf(event.toolEvent).toEqualTypeOf<ToolEvent>()
          break
        case EventType.TaskOpenRequested:
        case EventType.TaskDeleted:
          expectTypeOf(event.taskId).toEqualTypeOf<string>()
          break
        case EventType.QueueChanged:
          expectTypeOf(event.queuedMessages).toEqualTypeOf<readonly QueuedMessage[]>()
          break
        case EventType.QuestionOpened:
        case EventType.QuestionAnswered:
        case EventType.QuestionWithdrawn:
          expectTypeOf(event.questionSet).toEqualTypeOf<QuestionSet>()
          break
        case EventType.PermissionOpened:
        case EventType.PermissionAnswered:
        case EventType.PermissionWithdrawn:
          expectTypeOf(event.permissionRequest).toEqualTypeOf<PermissionRequest>()
          break
        case EventType.OpenFilesChanged:
          expectTypeOf(event.openFiles).toEqualTypeOf<OpenFiles>()
          break
        case EventType.FileShown:
          expectTypeOf(event.line).toEqualTypeOf<number | null>()
          break
        case EventType.TodosChanged:
          expectTypeOf(event.todos).toEqualTypeOf<TodoList | null>()
          break
        case EventType.ArtifactsChanged:
          expectTypeOf(event.artifacts).toEqualTypeOf<readonly Artifact[]>()
          break
        case EventType.TerminalTabsChanged:
          expectTypeOf(event.tabs).toEqualTypeOf<readonly TerminalTab[]>()
          break
        case EventType.TerminalOutput:
          expectTypeOf(event.data).toEqualTypeOf<string>()
          break
        case EventType.TerminalCleared:
          expectTypeOf(event.tabId).toEqualTypeOf<string>()
          break
        case EventType.WorkspaceRemoved:
          expectTypeOf(event.workspaceId).toEqualTypeOf<string>()
          break
        case EventType.MenuCommand:
          expectTypeOf(event.command).toEqualTypeOf<Command>()
          break
        case EventType.SettingsChanged:
          expectTypeOf(event.settings).toEqualTypeOf<Settings>()
          break
        case EventType.PluginsChanged:
          expectTypeOf(event.plugins).toEqualTypeOf<readonly InstalledPlugin[]>()
          break
        case EventType.PluginStatusChanged:
          expectTypeOf(event.text).toEqualTypeOf<string>()
          break
      }
    })
  })
})
