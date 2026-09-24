/**
 * The app's commands. A command runs in the renderer, whichever way it's asked for: main sends the menu bar's (and so
 * its keys') as `menu.command` events, and the window's own key dispatcher runs the rest (`WindowCommandId`). The keys
 * that run each one are in the keymap (`keymap.ts`), which the menu bar's accelerators, the window's dispatcher and
 * every hint read, so they can't disagree, and which Settings › Keyboard rebinds.
 */
import type { KeyBindingOverrides } from './keymap'

/** What a command acts on. */
export enum CommandScope {
  /** The app as a whole. */
  App = 'app',
  /** One workspace, named by the command. */
  Workspace = 'workspace',
  /** One task, named by the command. */
  Task = 'task',
}

/** The commands that act on the app as a whole. */
export enum AppCommandId {
  Settings = 'app.settings',
  NewTask = 'app.newTask',
  /** Closes what has the focus: a file tab, a terminal tab, or else the window (see `src/renderer/commands`). */
  Close = 'app.close',
  NewWorkspace = 'app.newWorkspace',
  OpenFolder = 'app.openFolder',
  ToggleSidebar = 'app.toggleSidebar',
  ToggleRightPanel = 'app.toggleRightPanel',
  ToggleBottomBar = 'app.toggleBottomBar',
}

/** The commands that act on one workspace. */
export enum WorkspaceCommandId {
  Switch = 'workspace.switch',
  Rename = 'workspace.rename',
  ChangeRoot = 'workspace.changeRoot',
  Settings = 'workspace.settings',
  RevealRoot = 'workspace.revealRoot',
  Close = 'workspace.close',
  Remove = 'workspace.remove',
}

/** The commands that act on one task: the selected one, when they come from the menu bar. */
export enum TaskCommandId {
  TogglePin = 'task.togglePin',
  Rename = 'task.rename',
  MarkUnread = 'task.markUnread',
  MarkDone = 'task.markDone',
  Reopen = 'task.reopen',
  CopyLink = 'task.copyLink',
  CopyOutcome = 'task.copyOutcome',
  Delete = 'task.delete',
}

/**
 * The commands the window runs from its own keys, not the menu bar's: the ones that act on what has the focus, or that
 * the menu bar has no item for.
 */
export enum WindowCommandId {
  JumpToTask = 'window.jumpToTask',
  SearchTasks = 'window.searchTasks',
  NextTask = 'window.nextTask',
  PreviousTask = 'window.previousTask',
  NextTaskNeedingYou = 'window.nextTaskNeedingYou',
  ContextMenu = 'window.contextMenu',
  Send = 'window.send',
  NewLine = 'window.newLine',
  StopAgent = 'window.stopAgent',
  CompactContext = 'window.compactContext',
  EditLastQueued = 'window.editLastQueued',
  FocusInput = 'window.focusInput',
  ShowPanelTab = 'window.showPanelTab',
  OpenInEditor = 'window.openInEditor',
  FocusTerminal = 'window.focusTerminal',
  NewTerminalTab = 'window.newTerminalTab',
  NextTerminalTab = 'window.nextTerminalTab',
  PreviousTerminalTab = 'window.previousTerminalTab',
  ClearTerminal = 'window.clearTerminal',
  KillProcess = 'window.killProcess',
  MenuMove = 'window.menuMove',
  MenuChoose = 'window.menuChoose',
  MenuClose = 'window.menuClose',
  SelectAnswer = 'window.selectAnswer',
}

/** The commands the menu bar runs. */
export type CommandId = AppCommandId | WorkspaceCommandId | TaskCommandId

export interface AppCommand {
  readonly scope: CommandScope.App
  readonly id: AppCommandId
}

export interface WorkspaceCommand {
  readonly scope: CommandScope.Workspace
  readonly id: WorkspaceCommandId
  readonly workspaceId: string
}

export interface TaskCommand {
  readonly scope: CommandScope.Task
  readonly id: TaskCommandId
  readonly taskId: string
}

/** A command to run, with what it acts on. */
export type Command = AppCommand | WorkspaceCommand | TaskCommand

export function appCommand(id: AppCommandId): AppCommand {
  return { scope: CommandScope.App, id }
}

export function workspaceCommand(id: WorkspaceCommandId, workspaceId: string): WorkspaceCommand {
  return { scope: CommandScope.Workspace, id, workspaceId }
}

export function taskCommand(id: TaskCommandId, taskId: string): TaskCommand {
  return { scope: CommandScope.Task, id, taskId }
}

/** The label of the item that pins a task, or unpins a pinned one, in the menu bar and the task's context menu. */
export function pinLabel(pinned: boolean): string {
  return pinned ? 'Unpin' : 'Pin to top'
}

// What the menu bar shows

/** A workspace, as the menu bar lists it. */
export interface MenuWorkspace {
  readonly id: string
  readonly name: string
}

/** The selected task, as the Task menu needs it: what it can do now. */
export interface MenuTask {
  readonly id: string
  readonly pinned: boolean
  readonly canRename: boolean
  readonly canMarkUnread: boolean
  readonly canMarkDone: boolean
  readonly canReopen: boolean
  readonly canCopyOutcome: boolean
}

/** The panels the window can toggle now. */
export interface MenuPanels {
  readonly sidebar: boolean
  readonly rightPanel: boolean
  readonly bottomBar: boolean
}

/**
 * What the menu bar shows, as the window reports it: the workspaces, the one shown, the selected task and the panels.
 * Main rebuilds the menu bar from it.
 */
export interface MenuState {
  /** Every workspace, oldest first (the switcher's order, which ⌘1 – ⌘9 follow). */
  readonly workspaces: readonly MenuWorkspace[]
  /** The workspace the window shows; null for none (the first-run window). */
  readonly shownWorkspaceId: string | null
  /** The selected task; null for none. */
  readonly task: MenuTask | null
  readonly panels: MenuPanels
  /** The shortcuts you've rebound (Settings › Keyboard), so the menu bar's items show and answer the current keys. */
  readonly keyBindings: KeyBindingOverrides
}

/** The menu bar before the window reports anything: nothing to act on. */
export const EMPTY_MENU_STATE: MenuState = {
  workspaces: [],
  shownWorkspaceId: null,
  task: null,
  panels: { sidebar: false, rightPanel: false, bottomBar: false },
  keyBindings: {},
}
