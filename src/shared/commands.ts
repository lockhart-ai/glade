/**
 * The app's commands and the keys that run them: one table the menu bar's accelerators and the shortcut hints the
 * window shows are both read from, so they can't disagree. A command runs in the renderer, whichever way it's asked
 * for: main sends the menu bar's (and so its keys') as `menu.command` events.
 *
 * The keymap registry (P7-04) grows this into every shortcut in `docs/keymap.md`, rebindable in Settings.
 */

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

/**
 * A key combination, as Electron's menus take it (`CmdOrCtrl+Shift+P`): its modifiers in the order the window shows
 * them, then the key.
 */
export type Accelerator = string

/**
 * The keys that run commands (`docs/keymap.md`). A command with none has no shortcut. Workspace settings shares ⌘,
 * with Settings, as the design shows it; the key opens Settings, the first of the two in the menu bar.
 */
export const KEYMAP: Readonly<Partial<Record<CommandId, Accelerator>>> = {
  [AppCommandId.Settings]: 'CmdOrCtrl+,',
  [AppCommandId.NewTask]: 'CmdOrCtrl+N',
  [AppCommandId.Close]: 'CmdOrCtrl+W',
  [AppCommandId.NewWorkspace]: 'CmdOrCtrl+Shift+N',
  [AppCommandId.OpenFolder]: 'CmdOrCtrl+O',
  [AppCommandId.ToggleSidebar]: 'CmdOrCtrl+B',
  [AppCommandId.ToggleRightPanel]: 'CmdOrCtrl+Alt+B',
  [AppCommandId.ToggleBottomBar]: 'CmdOrCtrl+J',
  [WorkspaceCommandId.Settings]: 'CmdOrCtrl+,',
  [WorkspaceCommandId.Close]: 'CmdOrCtrl+Shift+W',
  [TaskCommandId.TogglePin]: 'CmdOrCtrl+Shift+P',
  [TaskCommandId.Rename]: 'F2',
  [TaskCommandId.MarkUnread]: 'CmdOrCtrl+Shift+U',
  [TaskCommandId.MarkDone]: 'CmdOrCtrl+Shift+D',
}

/** How many workspaces have a key to switch to them: ⌘1 – ⌘9. */
export const SWITCH_KEYS = 9

/** The key that switches to the workspace at `position` (from 1, oldest first): ⌘1 – ⌘9, or none past the ninth. */
export function switchWorkspaceAccelerator(position: number): Accelerator | undefined {
  return Number.isInteger(position) && position >= 1 && position <= SWITCH_KEYS
    ? `CmdOrCtrl+${String(position)}`
    : undefined
}

const MODIFIER_SYMBOLS: Readonly<Record<string, string>> = {
  CmdOrCtrl: '⌘',
  Command: '⌘',
  Cmd: '⌘',
  Alt: '⌥',
  Option: '⌥',
  Shift: '⇧',
  Ctrl: '⌃',
  Control: '⌃',
}

/** A key combination as the window shows it beside a menu item or in a tooltip: `CmdOrCtrl+Shift+P` is `⌘⇧P`. */
export function shortcutHint(accelerator: Accelerator): string {
  return accelerator
    .split('+')
    .map((part) => MODIFIER_SYMBOLS[part] ?? part.toUpperCase())
    .join('')
}

/** The hint for a command's key; empty when it has none. */
export function commandHint(id: CommandId): string {
  const accelerator = KEYMAP[id]
  return accelerator === undefined ? '' : shortcutHint(accelerator)
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
}

/** The menu bar before the window reports anything: nothing to act on. */
export const EMPTY_MENU_STATE: MenuState = {
  workspaces: [],
  shownWorkspaceId: null,
  task: null,
  panels: { sidebar: false, rightPanel: false, bottomBar: false },
}
