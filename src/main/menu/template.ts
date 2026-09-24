/**
 * The menu bar (`docs/design/html/15-workspace-menu.html`), built from what the window reports it shows: Glade, File,
 * Edit, View, Workspace, Task, Window and Help. Pure, so it can be checked without Electron: the app hands the template
 * to `Menu.buildFromTemplate`.
 *
 * Every item of Glade's own runs a `Command` in the window, and each has the key the keymap gives it now
 * (`keymap.ts`, with the bindings you've changed, which the window reports in `MenuState`): the menu bar is what answers
 * those keys, so the window doesn't also listen for them. An item whose command can't run now is disabled, and its key
 * does nothing.
 */
import type { MenuItemConstructorOptions } from 'electron'
import {
  appCommand,
  AppCommandId,
  pinLabel,
  taskCommand,
  TaskCommandId,
  workspaceCommand,
  WorkspaceCommandId,
  type Command,
  type CommandId,
  type MenuState,
} from '../../shared/commands'
import { acceleratorOf, hasShortcut, resolveKeymap, type Accelerator, type Keymap } from '../../shared/keymap'

/** Runs a command in the window. */
export type RunCommand = (command: Command) => void

export interface MenuOptions {
  /** The app's name, for About, Hide and Quit. */
  readonly appName: string
  /** Whether to add the developer's items (Reload, Toggle Developer Tools) to View: only outside a packaged app. */
  readonly developer: boolean
}

const SEPARATOR: MenuItemConstructorOptions = { type: 'separator' }

/** The id of the Switch workspace item for a workspace, so it can be found in the built menu. */
export function switchItemId(workspaceId: string): string {
  return `${WorkspaceCommandId.Switch}:${workspaceId}`
}

/** What the menu bar's items are built with: the commands they run and the keys they answer. */
interface Build {
  readonly run: RunCommand
  readonly keymap: Keymap
}

/**
 * An item that runs a command, with its key: disabled when `command` is null, for a command that can't run now. Its
 * id is the command's (`id`), so it can be found in the built menu.
 */
function commandItem(
  label: string,
  id: CommandId,
  command: Command | null,
  { run, keymap }: Build,
  accelerator: Accelerator | undefined = keyOf(keymap, id),
): MenuItemConstructorOptions {
  return {
    id,
    label,
    enabled: command !== null,
    ...(accelerator === undefined ? {} : { accelerator }),
    click: () => {
      if (command !== null) run(command)
    },
  }
}

/**
 * A menu bar command's key in `keymap`, or none for a command without one. Workspace settings… shares Settings…' key,
 * as the design shows it; the key opens Settings, the first of the two in the menu bar.
 */
function keyOf(keymap: Keymap, id: CommandId): Accelerator | undefined {
  const shortcut = id === WorkspaceCommandId.Settings ? AppCommandId.Settings : id
  return hasShortcut(shortcut) ? acceleratorOf(keymap, shortcut) : undefined
}

function gladeMenu({ appName }: MenuOptions, build: Build): MenuItemConstructorOptions {
  return {
    label: appName,
    submenu: [
      { role: 'about', label: `About ${appName}` },
      SEPARATOR,
      commandItem('Settings…', AppCommandId.Settings, appCommand(AppCommandId.Settings), build),
      SEPARATOR,
      { role: 'hide', label: `Hide ${appName}` },
      { role: 'hideOthers' },
      { role: 'unhide' },
      SEPARATOR,
      { role: 'quit', label: `Quit ${appName}` },
    ],
  }
}

function fileMenu(state: MenuState, build: Build): MenuItemConstructorOptions {
  const shown = state.shownWorkspaceId !== null
  return {
    label: 'File',
    submenu: [
      commandItem('New task', AppCommandId.NewTask, shown ? appCommand(AppCommandId.NewTask) : null, build),
      SEPARATOR,
      // ⌘W: the window closes the file or terminal tab that has the focus, or else itself.
      commandItem('Close', AppCommandId.Close, appCommand(AppCommandId.Close), build),
    ],
  }
}

function editMenu(): MenuItemConstructorOptions {
  return {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      SEPARATOR,
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  }
}

function viewMenu({ panels }: MenuState, { developer }: MenuOptions, build: Build): MenuItemConstructorOptions {
  const toggle = (label: string, id: AppCommandId, available: boolean): MenuItemConstructorOptions =>
    commandItem(label, id, available ? appCommand(id) : null, build)
  return {
    label: 'View',
    submenu: [
      toggle('Toggle task list', AppCommandId.ToggleSidebar, panels.sidebar),
      toggle('Toggle right panel', AppCommandId.ToggleRightPanel, panels.rightPanel),
      toggle('Toggle bottom bar', AppCommandId.ToggleBottomBar, panels.bottomBar),
      SEPARATOR,
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      SEPARATOR,
      { role: 'togglefullscreen' },
      ...(developer ? [SEPARATOR, { role: 'reload' as const }, { role: 'toggleDevTools' as const }] : []),
    ],
  }
}

function workspaceMenu(state: MenuState, build: Build): MenuItemConstructorOptions {
  const { workspaces, shownWorkspaceId: shown } = state
  const onShown = (id: WorkspaceCommandId): Command | null => (shown === null ? null : workspaceCommand(id, shown))
  const item = (label: string, id: WorkspaceCommandId): MenuItemConstructorOptions =>
    commandItem(label, id, onShown(id), build)
  return {
    label: 'Workspace',
    submenu: [
      {
        id: WorkspaceCommandId.Switch,
        label: 'Switch workspace',
        enabled: workspaces.length > 0,
        submenu: workspaces.map((workspace, index) => ({
          ...commandItem(
            workspace.name,
            WorkspaceCommandId.Switch,
            workspaceCommand(WorkspaceCommandId.Switch, workspace.id),
            build,
            acceleratorOf(build.keymap, WorkspaceCommandId.Switch, index + 1),
          ),
          id: switchItemId(workspace.id),
          type: 'checkbox' as const,
          checked: workspace.id === shown,
        })),
      },
      commandItem('New workspace…', AppCommandId.NewWorkspace, appCommand(AppCommandId.NewWorkspace), build),
      commandItem('Open folder as workspace…', AppCommandId.OpenFolder, appCommand(AppCommandId.OpenFolder), build),
      SEPARATOR,
      item('Rename workspace…', WorkspaceCommandId.Rename),
      item('Change root folder…', WorkspaceCommandId.ChangeRoot),
      item('Workspace settings…', WorkspaceCommandId.Settings),
      item('Reveal root in Finder', WorkspaceCommandId.RevealRoot),
      SEPARATOR,
      item('Close workspace', WorkspaceCommandId.Close),
      item('Remove from list…', WorkspaceCommandId.Remove),
    ],
  }
}

/** The Task menu: the selected task's actions, as its context menu has them, each disabled when it doesn't apply. */
function taskMenu({ task }: MenuState, build: Build): MenuItemConstructorOptions {
  const on = (id: TaskCommandId, applies: boolean): Command | null =>
    task !== null && applies ? taskCommand(id, task.id) : null
  const item = (label: string, id: TaskCommandId, applies: boolean): MenuItemConstructorOptions =>
    commandItem(label, id, on(id, applies), build)
  return {
    label: 'Task',
    submenu: [
      item(pinLabel(task?.pinned ?? false), TaskCommandId.TogglePin, true),
      item('Rename…', TaskCommandId.Rename, task?.canRename ?? false),
      item('Mark as unread', TaskCommandId.MarkUnread, task?.canMarkUnread ?? false),
      SEPARATOR,
      item('Mark done', TaskCommandId.MarkDone, task?.canMarkDone ?? false),
      item('Reopen', TaskCommandId.Reopen, task?.canReopen ?? false),
      SEPARATOR,
      item('Copy link to task', TaskCommandId.CopyLink, true),
      item('Copy outcome', TaskCommandId.CopyOutcome, task?.canCopyOutcome ?? false),
      SEPARATOR,
      item('Delete task…', TaskCommandId.Delete, true),
    ],
  }
}

/**
 * The menu bar for what the window shows, each of Glade's items running its command through `run` and answering its
 * key in the keymap, with the bindings `state` carries.
 */
export function menuTemplate(state: MenuState, options: MenuOptions, run: RunCommand): MenuItemConstructorOptions[] {
  const build: Build = { run, keymap: resolveKeymap(state.keyBindings) }
  return [
    gladeMenu(options, build),
    fileMenu(state, build),
    editMenu(),
    viewMenu(state, options, build),
    workspaceMenu(state, build),
    taskMenu(state, build),
    { role: 'windowMenu' },
    { role: 'help', submenu: [] },
  ]
}
