/**
 * The menu bar (`docs/design/html/15-workspace-menu.html`), built from what the window reports it shows: Glade, File,
 * Edit, View, Workspace, Task, Window and Help. Pure, so it can be checked without Electron: the app hands the template
 * to `Menu.buildFromTemplate`.
 *
 * Every item of Glade's own runs a `Command` in the window, and each has the key the keymap gives it (`KEYMAP`): the
 * menu bar is what answers those keys, so the window doesn't also listen for them. An item whose command can't run
 * now is disabled, and its key does nothing.
 */
import type { MenuItemConstructorOptions } from 'electron'
import {
  appCommand,
  AppCommandId,
  KEYMAP,
  pinLabel,
  switchWorkspaceAccelerator,
  taskCommand,
  TaskCommandId,
  workspaceCommand,
  WorkspaceCommandId,
  type Accelerator,
  type Command,
  type CommandId,
  type MenuState,
} from '../../shared/commands'

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

/**
 * An item that runs a command, with its key: disabled when `command` is null, for a command that can't run now. Its
 * id is the command's (`id`), so it can be found in the built menu.
 */
function commandItem(
  label: string,
  id: CommandId,
  command: Command | null,
  run: RunCommand,
  accelerator: Accelerator | undefined = KEYMAP[id],
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

function gladeMenu({ appName }: MenuOptions, run: RunCommand): MenuItemConstructorOptions {
  return {
    label: appName,
    submenu: [
      { role: 'about', label: `About ${appName}` },
      SEPARATOR,
      commandItem('Settings…', AppCommandId.Settings, appCommand(AppCommandId.Settings), run),
      SEPARATOR,
      { role: 'hide', label: `Hide ${appName}` },
      { role: 'hideOthers' },
      { role: 'unhide' },
      SEPARATOR,
      { role: 'quit', label: `Quit ${appName}` },
    ],
  }
}

function fileMenu(state: MenuState, run: RunCommand): MenuItemConstructorOptions {
  const shown = state.shownWorkspaceId !== null
  return {
    label: 'File',
    submenu: [
      commandItem('New task', AppCommandId.NewTask, shown ? appCommand(AppCommandId.NewTask) : null, run),
      SEPARATOR,
      // ⌘W: the window closes the file or terminal tab that has the focus, or else itself.
      commandItem('Close', AppCommandId.Close, appCommand(AppCommandId.Close), run),
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

function viewMenu({ panels }: MenuState, { developer }: MenuOptions, run: RunCommand): MenuItemConstructorOptions {
  const toggle = (label: string, id: AppCommandId, available: boolean): MenuItemConstructorOptions =>
    commandItem(label, id, available ? appCommand(id) : null, run)
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

function workspaceMenu(state: MenuState, run: RunCommand): MenuItemConstructorOptions {
  const { workspaces, shownWorkspaceId: shown } = state
  const onShown = (id: WorkspaceCommandId): Command | null => (shown === null ? null : workspaceCommand(id, shown))
  const item = (label: string, id: WorkspaceCommandId): MenuItemConstructorOptions =>
    commandItem(label, id, onShown(id), run)
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
            run,
            switchWorkspaceAccelerator(index + 1),
          ),
          id: switchItemId(workspace.id),
          type: 'checkbox' as const,
          checked: workspace.id === shown,
        })),
      },
      commandItem('New workspace…', AppCommandId.NewWorkspace, appCommand(AppCommandId.NewWorkspace), run),
      commandItem('Open folder as workspace…', AppCommandId.OpenFolder, appCommand(AppCommandId.OpenFolder), run),
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
function taskMenu({ task }: MenuState, run: RunCommand): MenuItemConstructorOptions {
  const on = (id: TaskCommandId, applies: boolean): Command | null =>
    task !== null && applies ? taskCommand(id, task.id) : null
  const item = (label: string, id: TaskCommandId, applies: boolean): MenuItemConstructorOptions =>
    commandItem(label, id, on(id, applies), run)
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

/** The menu bar for what the window shows, each of Glade's items running its command through `run`. */
export function menuTemplate(state: MenuState, options: MenuOptions, run: RunCommand): MenuItemConstructorOptions[] {
  return [
    gladeMenu(options, run),
    fileMenu(state, run),
    editMenu(),
    viewMenu(state, options, run),
    workspaceMenu(state, run),
    taskMenu(state, run),
    { role: 'windowMenu' },
    { role: 'help', submenu: [] },
  ]
}
