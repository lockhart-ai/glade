/**
 * The typed bridge between the main process and the renderer: one command API and one event stream.
 *
 * - **Commands** are request/response calls from the renderer to main. `CommandMap` is the single source of truth: the
 *   preload's `invoke`, the main-side handler registry and the request validators are all typed from it, so changing a
 *   command's request or response on one side without the other fails the typecheck.
 * - **Events** flow from main to every window. `GladeEvent` is a discriminated union on `type`.
 * - **Errors**: main answers every command with a `BridgeResult`. The preload unwraps it, resolving with the value or
 *   rejecting with a `BridgeError`. `BridgeError` is a plain object, not an `Error`: `contextBridge` copies an `Error`
 *   thrown into the renderer's world but drops its extra properties, so `code` wouldn't survive.
 */
import type { Effort, Message, Task, ToolEvent, UiStateEntry, UiStateKey, Workspace } from './domain'

/** The name the bridge is exposed under on `window`. */
export const BRIDGE_KEY = 'glade'

/** The IPC channel every command is invoked on (`ipcRenderer.invoke` → `ipcMain.handle`). */
export const COMMAND_CHANNEL = 'glade:command'

/** The IPC channel main sends every event on (`webContents.send` → `ipcRenderer.on`). */
export const EVENT_CHANNEL = 'glade:event'

// Commands

export enum CommandName {
  WorkspacesList = 'workspaces.list',
  WorkspacesCreate = 'workspaces.create',
  WorkspacesOpen = 'workspaces.open',
  DialogChooseFolder = 'dialog.chooseFolder',
  TasksList = 'tasks.list',
  TasksCreate = 'tasks.create',
  TasksMarkDone = 'tasks.markDone',
  TasksReopen = 'tasks.reopen',
  TasksUpdate = 'tasks.update',
  TasksSend = 'tasks.send',
  TasksStop = 'tasks.stop',
  TasksHistory = 'tasks.history',
  UiStateGet = 'uiState.get',
  UiStateGetAll = 'uiState.getAll',
  UiStateSet = 'uiState.set',
}

/** The request of a command that takes no arguments: pass `{}`. */
export type EmptyRequest = Record<string, never>

export interface WorkspacesListResponse {
  /** Every workspace, oldest first. */
  readonly workspaces: readonly Workspace[]
}

/**
 * Adds a workspace rooted at an existing folder, named after the folder. If a workspace already has that root, answers
 * with it instead of adding another. Writes a starter `CLAUDE.md` into a new workspace's root when it has none.
 * Broadcasts `workspace.updated` when a workspace is added. Fails with `invalid_root_path` when the root isn't an
 * existing directory.
 */
export interface WorkspacesCreateRequest {
  /** An absolute path to an existing directory. */
  readonly rootPath: string
}

export interface WorkspacesCreateResponse {
  readonly workspace: Workspace
  /** False when a workspace with that root already existed and is the one answered with. */
  readonly created: boolean
}

/**
 * Opens a workspace: records it as last opened and makes it the window's workspace (deselecting a task in another
 * workspace). Broadcasts `workspace.updated` and `uiState.changed`. Fails with `not_found` for an unknown id.
 */
export interface WorkspacesOpenRequest {
  readonly id: string
}

export interface WorkspacesOpenResponse {
  readonly workspace: Workspace
}

/** Shows the native open-folder dialog, which can also create a new folder. */
export interface DialogChooseFolderResponse {
  /** The chosen folder's absolute path; null when the dialog was cancelled. */
  readonly path: string | null
}

export interface TasksListRequest {
  readonly workspaceId: string
}

export interface TasksListResponse {
  /** The workspace's tasks, most recently updated first. */
  readonly tasks: readonly Task[]
}

/** Creates an active task with an empty title, objective and status, and the default model and effort. */
export interface TasksCreateRequest {
  readonly workspaceId: string
}

/** Names one task. */
export interface TaskIdRequest {
  readonly id: string
}

/**
 * The task fields the user can change. The title, objective and status the agent sets go through main's task service,
 * not this command; the state changes only through `tasks.markDone` and `tasks.reopen`.
 */
export interface TaskUserPatch {
  readonly title?: string
  readonly pinned?: boolean
  readonly unread?: boolean
  readonly model?: string
  readonly effort?: Effort
}

export interface TasksUpdateRequest {
  readonly id: string
  readonly patch: TaskUserPatch
}

/**
 * What every task command answers with: the task as it now is. Each also broadcasts `task.updated` with it.
 *
 * - `tasks.markDone`: an active task becomes done and `doneAt` is set; its status is its outcome.
 * - `tasks.reopen`: a done task becomes active and `doneAt` is cleared. Straight after `tasks.markDone`, it restores
 *   every field but `updatedAt`, so it's also how Undo works.
 * - Either one on a task already in the target state fails with `invalid_transition`; any task command on a task that
 *   doesn't exist fails with `not_found`.
 */
export interface TaskResponse {
  readonly task: Task
}

/**
 * Sends the user's message to a task's agent, starting a turn. A done task is reopened by it: it becomes active, its
 * `doneAt` is cleared, and the tool log gets marked done (stamped with the old `doneAt`) and reopened dividers before
 * the new turn's. Answers once the message is saved and handed to the agent, not when the turn ends: the turn's
 * progress arrives as `message.appended`, `toolEvent.appended`, `toolEvent.updated` and `task.updated` events.
 *
 * Fails with `busy` while the agent is working on a turn, and `not_found` when there's no such task.
 */
export interface TasksSendRequest {
  readonly id: string
  /** Markdown. Not blank. */
  readonly text: string
}

export interface TasksSendResponse {
  /** The user's message, as saved to the chat log. */
  readonly message: Message
}

/**
 * Stops the task's agent: interrupts its running turn, and answers with the task once the turn has ended, back to
 * waiting on you. The session stays alive, so the next `tasks.send` carries on in it. What the turn already saved
 * stays; its unfinished tool calls end as errors, and the tool log notes that you stopped it.
 *
 * On a task whose agent isn't working it does nothing and answers with the task. Fails with `not_found` when there's
 * no such task.
 */
export type TasksStopRequest = TaskIdRequest

/** A task's chat log and tool log, each in the order they were appended. */
export interface TasksHistoryResponse {
  readonly messages: readonly Message[]
  readonly toolEvents: readonly ToolEvent[]
}

export interface UiStateGetRequest {
  readonly key: UiStateKey
}

export interface UiStateGetResponse {
  /** Null when the key has never been set. */
  readonly value: string | null
}

export interface UiStateGetAllResponse {
  /** Every UI state value that has been set. */
  readonly entries: readonly UiStateEntry[]
}

/** Sets one UI state value. Broadcasts `uiState.changed`. */
export type UiStateSetRequest = UiStateEntry

/** One command's request and response types. */
export interface CommandSpec<Request, Response> {
  readonly request: Request
  readonly response: Response
}

/** Each command's request and response. Add a command here and the handler registry won't typecheck until it has one. */
export interface CommandMap {
  [CommandName.WorkspacesList]: CommandSpec<EmptyRequest, WorkspacesListResponse>
  [CommandName.WorkspacesCreate]: CommandSpec<WorkspacesCreateRequest, WorkspacesCreateResponse>
  [CommandName.WorkspacesOpen]: CommandSpec<WorkspacesOpenRequest, WorkspacesOpenResponse>
  [CommandName.DialogChooseFolder]: CommandSpec<EmptyRequest, DialogChooseFolderResponse>
  [CommandName.TasksList]: CommandSpec<TasksListRequest, TasksListResponse>
  [CommandName.TasksCreate]: CommandSpec<TasksCreateRequest, TaskResponse>
  [CommandName.TasksMarkDone]: CommandSpec<TaskIdRequest, TaskResponse>
  [CommandName.TasksReopen]: CommandSpec<TaskIdRequest, TaskResponse>
  [CommandName.TasksUpdate]: CommandSpec<TasksUpdateRequest, TaskResponse>
  [CommandName.TasksSend]: CommandSpec<TasksSendRequest, TasksSendResponse>
  [CommandName.TasksStop]: CommandSpec<TasksStopRequest, TaskResponse>
  [CommandName.TasksHistory]: CommandSpec<TaskIdRequest, TasksHistoryResponse>
  [CommandName.UiStateGet]: CommandSpec<UiStateGetRequest, UiStateGetResponse>
  [CommandName.UiStateGetAll]: CommandSpec<EmptyRequest, UiStateGetAllResponse>
  [CommandName.UiStateSet]: CommandSpec<UiStateSetRequest, null>
}

export type CommandRequest<C extends CommandName> = CommandMap[C]['request']
export type CommandResponse<C extends CommandName> = CommandMap[C]['response']

// Events

export enum EventType {
  UiStateChanged = 'uiState.changed',
  WorkspaceUpdated = 'workspace.updated',
  TaskUpdated = 'task.updated',
  MessageAppended = 'message.appended',
  ToolEventAppended = 'toolEvent.appended',
  ToolEventUpdated = 'toolEvent.updated',
}

export interface UiStateChangedEvent {
  readonly type: EventType.UiStateChanged
  readonly entry: UiStateEntry
}

/** A workspace was added or changed. Carries the whole workspace as it now is. */
export interface WorkspaceUpdatedEvent {
  readonly type: EventType.WorkspaceUpdated
  readonly workspace: Workspace
}

/** A task was created or changed. Carries the whole task as it now is. */
export interface TaskUpdatedEvent {
  readonly type: EventType.TaskUpdated
  readonly task: Task
}

/** A message was appended to a task's chat log. */
export interface MessageAppendedEvent {
  readonly type: EventType.MessageAppended
  readonly message: Message
}

/** An entry was appended to a task's tool log. */
export interface ToolEventAppendedEvent {
  readonly type: EventType.ToolEventAppended
  readonly toolEvent: ToolEvent
}

/** A tool log entry changed: a tool call's result arrived. Carries the whole entry as it now is. */
export interface ToolEventUpdatedEvent {
  readonly type: EventType.ToolEventUpdated
  readonly toolEvent: ToolEvent
}

/** Everything main broadcasts to the windows. */
export type GladeEvent =
  | UiStateChangedEvent
  | WorkspaceUpdatedEvent
  | TaskUpdatedEvent
  | MessageAppendedEvent
  | ToolEventAppendedEvent
  | ToolEventUpdatedEvent

export type EventListener = (event: GladeEvent) => void

/** Stops a subscription. Calling it again does nothing. */
export type Unsubscribe = () => void

// Errors

export enum BridgeErrorCode {
  /** The command name isn't in `CommandMap`. */
  UnknownCommand = 'unknown_command',
  /** The request doesn't match the command's request type. */
  InvalidRequest = 'invalid_request',
  /** The command names something that doesn't exist, such as a deleted task or workspace. */
  NotFound = 'not_found',
  /** The command asks for a state change the thing's current state doesn't allow, such as reopening an active task. */
  InvalidTransition = 'invalid_transition',
  /** The agent is working on a turn, so it can't take another message yet. */
  Busy = 'busy',
  /** A workspace root that isn't an existing directory. */
  InvalidRootPath = 'invalid_root_path',
  /** The handler threw. */
  Internal = 'internal',
}

/** Why a command failed. What a rejected `invoke` promise rejects with. */
export interface BridgeError {
  readonly name: 'BridgeError'
  readonly code: BridgeErrorCode
  readonly message: string
}

/** How main answers a command across IPC. */
export type BridgeResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: BridgeError }

export function bridgeError(code: BridgeErrorCode, message: string): BridgeError {
  return { name: 'BridgeError', code, message }
}

/** Whether a rejection from `invoke` is a `BridgeError`. */
export function isBridgeError(value: unknown): value is BridgeError {
  return (
    typeof value === 'object' &&
    value !== null &&
    Reflect.get(value, 'name') === 'BridgeError' &&
    Object.values<unknown>(BridgeErrorCode).includes(Reflect.get(value, 'code')) &&
    typeof Reflect.get(value, 'message') === 'string'
  )
}

// The bridge

/** The API the preload exposes to the renderer as `window.glade`. */
export interface GladeBridge {
  /** Runs a command in main. Rejects with a `BridgeError` when it fails. */
  invoke<C extends CommandName>(command: C, request: CommandRequest<C>): Promise<CommandResponse<C>>
  /** Calls `listener` with every event main broadcasts, until unsubscribed. */
  subscribe(listener: EventListener): Unsubscribe
}
