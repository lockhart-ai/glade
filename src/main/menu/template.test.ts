import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  appCommand,
  AppCommandId,
  EMPTY_MENU_STATE,
  taskCommand,
  TaskCommandId,
  workspaceCommand,
  WorkspaceCommandId,
  type MenuState,
  type MenuTask,
} from '../../shared/commands'
import { acceleratorOf, COMMANDS, DEFAULT_KEYMAP, KeyScope } from '../../shared/keymap'
import { menuTemplate, switchItemId, type MenuOptions } from './template'

const OPTIONS: MenuOptions = { appName: 'Glade', developer: false }

const TASK: MenuTask = {
  id: 't1',
  pinned: false,
  canRename: true,
  canMarkUnread: true,
  canMarkDone: true,
  canReopen: false,
  canCopyOutcome: false,
}

/** Three workspaces, the first shown, with its task t1 selected. */
const STATE: MenuState = {
  workspaces: [
    { id: 'w1', name: 'Acme API' },
    { id: 'w2', name: 'Glade' },
    { id: 'w3', name: 'Dotfiles' },
  ],
  shownWorkspaceId: 'w1',
  task: TASK,
  panels: { sidebar: true, rightPanel: true, bottomBar: true },
  keyBindings: {},
}

function build(state: MenuState = STATE, options: MenuOptions = OPTIONS) {
  const run = vi.fn()
  return { template: menuTemplate(state, options, run), run }
}

function submenu(item: MenuItemConstructorOptions | undefined): MenuItemConstructorOptions[] {
  const items = item?.submenu
  if (!Array.isArray(items)) throw new Error(`${String(item?.label)} has no submenu`)
  return items
}

function menu(template: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions[] {
  return submenu(template.find((item) => item.label === label))
}

/** A menu as its items' labels (or roles, for the standard ones), with `—` for a separator. */
function outline(items: MenuItemConstructorOptions[]): string[] {
  return items.map((item) => (item.type === 'separator' ? '—' : (item.label ?? `(${String(item.role)})`)))
}

function item(items: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions {
  const found = items.find((each) => each.label === label)
  if (found === undefined) throw new Error(`No ${label}`)
  return found
}

/** Clicks an item as Electron would. */
function click(entry: MenuItemConstructorOptions): void {
  ;(entry.click as () => void)()
}

/** Each item's label and whether it's enabled, leaving out separators and the standard items. */
function enabled(items: MenuItemConstructorOptions[]): Record<string, boolean> {
  return Object.fromEntries(
    items.filter((each) => each.id !== undefined).map((each) => [String(each.label), each.enabled !== false]),
  )
}

describe('the menu bar', () => {
  it('has Glade, File, Edit, View, Workspace, Task, Window and Help', () => {
    const { template } = build()

    expect(template.map((each) => each.label ?? each.role)).toEqual([
      'Glade',
      'File',
      'Edit',
      'View',
      'Workspace',
      'Task',
      'windowMenu',
      'help',
    ])
    expect(menu(template, 'Glade').map((each) => each.role ?? each.type ?? each.label)).toEqual([
      'about',
      'separator',
      'Settings…',
      'separator',
      'hide',
      'hideOthers',
      'unhide',
      'separator',
      'quit',
    ])
    expect(outline(menu(template, 'Glade'))).toContain('Quit Glade')
    expect(menu(template, 'Edit').map((each) => each.role ?? each.type)).toEqual([
      'undo',
      'redo',
      'separator',
      'cut',
      'copy',
      'paste',
      'selectAll',
    ])
  })

  it('has the Workspace menu of the design, with the keys the keymap gives it', () => {
    const items = menu(build().template, 'Workspace')

    expect(outline(items)).toEqual([
      'Switch workspace',
      'New workspace…',
      'Open folder as workspace…',
      '—',
      'Rename workspace…',
      'Change root folder…',
      'Workspace settings…',
      'Reveal root in Finder',
      '—',
      'Close workspace',
      'Remove from list…',
    ])
    expect(item(items, 'New workspace…').accelerator).toBe('CmdOrCtrl+Shift+N')
    expect(item(items, 'Open folder as workspace…').accelerator).toBe('CmdOrCtrl+O')
    expect(item(items, 'Workspace settings…').accelerator).toBe('CmdOrCtrl+,')
    expect(item(items, 'Close workspace').accelerator).toBe('CmdOrCtrl+Shift+W')
    expect(item(items, 'Rename workspace…').accelerator).toBeUndefined()
  })

  it('answers the keys you’ve rebound in Settings › Keyboard, which the window reports', () => {
    const { template } = build({
      ...STATE,
      keyBindings: {
        [AppCommandId.Settings]: 'Ctrl+Alt+S',
        [WorkspaceCommandId.Switch]: 'Ctrl+1',
        [TaskCommandId.MarkDone]: 'Meta+Alt+D',
        [AppCommandId.ToggleSidebar]: 'F6',
      },
    })

    expect(item(menu(template, 'Glade'), 'Settings…').accelerator).toBe('Ctrl+Alt+S')
    // Workspace settings… shares Settings…' key.
    expect(item(menu(template, 'Workspace'), 'Workspace settings…').accelerator).toBe('Ctrl+Alt+S')
    expect(
      submenu(item(menu(template, 'Workspace'), 'Switch workspace')).map(({ accelerator }) => accelerator),
    ).toEqual(['Ctrl+1', 'Ctrl+2', 'Ctrl+3'])
    expect(item(menu(template, 'Task'), 'Mark done').accelerator).toBe('CmdOrCtrl+Alt+D')
    expect(item(menu(template, 'View'), 'Toggle task list').accelerator).toBe('F6')
    expect(item(menu(template, 'File'), 'New task').accelerator).toBe('CmdOrCtrl+N')
  })

  it('lists every workspace under Switch workspace, oldest first, with ⌘1 – ⌘9 and a check on the one shown', () => {
    const { template, run } = build()
    const switcher = item(menu(template, 'Workspace'), 'Switch workspace')

    expect(switcher.enabled).toBe(true)
    expect(
      submenu(switcher).map(({ id, label, accelerator, type, checked }) => ({ id, label, accelerator, type, checked })),
    ).toEqual([
      { id: switchItemId('w1'), label: 'Acme API', accelerator: 'CmdOrCtrl+1', type: 'checkbox', checked: true },
      { id: switchItemId('w2'), label: 'Glade', accelerator: 'CmdOrCtrl+2', type: 'checkbox', checked: false },
      { id: switchItemId('w3'), label: 'Dotfiles', accelerator: 'CmdOrCtrl+3', type: 'checkbox', checked: false },
    ])

    click(item(submenu(switcher), 'Glade'))
    expect(run).toHaveBeenCalledWith(workspaceCommand(WorkspaceCommandId.Switch, 'w2'))
  })

  it('gives only the first nine workspaces a key', () => {
    const workspaces = Array.from({ length: 11 }, (_, index) => ({
      id: `w${String(index)}`,
      name: `W${String(index)}`,
    }))
    const { template } = build({ ...STATE, workspaces })

    const keys = submenu(item(menu(template, 'Workspace'), 'Switch workspace')).map(({ accelerator }) => accelerator)

    expect(keys).toEqual([
      ...Array.from({ length: 9 }, (_, index) => `CmdOrCtrl+${String(index + 1)}`),
      undefined,
      undefined,
    ])
  })

  it('runs the shown workspace’s commands on it', () => {
    const { template, run } = build()
    const items = menu(template, 'Workspace')

    for (const [label, id] of [
      ['Rename workspace…', WorkspaceCommandId.Rename],
      ['Change root folder…', WorkspaceCommandId.ChangeRoot],
      ['Workspace settings…', WorkspaceCommandId.Settings],
      ['Reveal root in Finder', WorkspaceCommandId.RevealRoot],
      ['Close workspace', WorkspaceCommandId.Close],
      ['Remove from list…', WorkspaceCommandId.Remove],
    ] as const) {
      click(item(items, label))
      expect(run).toHaveBeenLastCalledWith(workspaceCommand(id, 'w1'))
    }
    click(item(items, 'New workspace…'))
    expect(run).toHaveBeenLastCalledWith(appCommand(AppCommandId.NewWorkspace))
    click(item(items, 'Open folder as workspace…'))
    expect(run).toHaveBeenLastCalledWith(appCommand(AppCommandId.OpenFolder))
  })

  it('disables what needs a workspace, a task or a panel in the first-run window, and runs nothing for it', () => {
    const { template, run } = build({ ...EMPTY_MENU_STATE, panels: { ...EMPTY_MENU_STATE.panels, bottomBar: true } })

    expect(item(menu(template, 'Workspace'), 'Switch workspace').enabled).toBe(false)
    expect(enabled(menu(template, 'Workspace'))).toEqual({
      'Switch workspace': false,
      'New workspace…': true,
      'Open folder as workspace…': true,
      'Rename workspace…': false,
      'Change root folder…': false,
      'Workspace settings…': false,
      'Reveal root in Finder': false,
      'Close workspace': false,
      'Remove from list…': false,
    })
    expect(enabled(menu(template, 'File'))).toEqual({ 'New task': false, Close: true })
    expect(enabled(menu(template, 'View'))).toEqual({
      'Toggle task list': false,
      'Toggle right panel': false,
      'Toggle bottom bar': true,
    })
    expect(Object.values(enabled(menu(template, 'Task')))).not.toContain(true)

    click(item(menu(template, 'Workspace'), 'Close workspace'))
    click(item(menu(template, 'Task'), 'Delete task…'))
    expect(run).not.toHaveBeenCalled()
  })

  it('has File’s New task and Close, and View’s panel toggles, zoom and full screen', () => {
    const { template, run } = build()

    expect(outline(menu(template, 'File'))).toEqual(['New task', '—', 'Close'])
    expect(item(menu(template, 'File'), 'New task').accelerator).toBe('CmdOrCtrl+N')
    expect(item(menu(template, 'File'), 'Close').accelerator).toBe('CmdOrCtrl+W')
    expect(outline(menu(template, 'View'))).toEqual([
      'Toggle task list',
      'Toggle right panel',
      'Toggle bottom bar',
      '—',
      '(resetZoom)',
      '(zoomIn)',
      '(zoomOut)',
      '—',
      '(togglefullscreen)',
    ])
    for (const [menuLabel, label, id, accelerator] of [
      ['File', 'New task', AppCommandId.NewTask, 'CmdOrCtrl+N'],
      ['File', 'Close', AppCommandId.Close, 'CmdOrCtrl+W'],
      ['Glade', 'Settings…', AppCommandId.Settings, 'CmdOrCtrl+,'],
      ['View', 'Toggle task list', AppCommandId.ToggleSidebar, 'CmdOrCtrl+B'],
      ['View', 'Toggle right panel', AppCommandId.ToggleRightPanel, 'CmdOrCtrl+Alt+B'],
      ['View', 'Toggle bottom bar', AppCommandId.ToggleBottomBar, 'CmdOrCtrl+J'],
    ] as const) {
      const entry = item(menu(template, menuLabel), label)
      expect(entry.accelerator).toBe(accelerator)
      click(entry)
      expect(run).toHaveBeenLastCalledWith(appCommand(id))
    }
  })

  it('adds Reload and the developer tools to View outside a packaged app', () => {
    const view = menu(build(STATE, { ...OPTIONS, developer: true }).template, 'View')

    expect(outline(view).slice(-3)).toEqual(['—', '(reload)', '(toggleDevTools)'])
  })

  describe('the Task menu', () => {
    it('mirrors the task’s context menu, for the selected task, with the keymap’s keys', () => {
      const { template, run } = build()
      const items = menu(template, 'Task')

      expect(outline(items)).toEqual([
        'Pin to top',
        'Rename…',
        'Mark as unread',
        '—',
        'Mark done',
        'Reopen',
        '—',
        'Copy link to task',
        'Copy outcome',
        '—',
        'Delete task…',
      ])
      expect(
        items.filter((each) => each.accelerator !== undefined).map((each) => [each.label, each.accelerator]),
      ).toEqual([
        ['Pin to top', 'CmdOrCtrl+Shift+P'],
        ['Rename…', 'F2'],
        ['Mark as unread', 'CmdOrCtrl+Shift+U'],
        ['Mark done', 'CmdOrCtrl+Shift+D'],
      ])
      for (const [label, id] of [
        ['Pin to top', TaskCommandId.TogglePin],
        ['Rename…', TaskCommandId.Rename],
        ['Mark as unread', TaskCommandId.MarkUnread],
        ['Mark done', TaskCommandId.MarkDone],
        ['Copy link to task', TaskCommandId.CopyLink],
        ['Delete task…', TaskCommandId.Delete],
      ] as const) {
        click(item(items, label))
        expect(run).toHaveBeenLastCalledWith(taskCommand(id, 't1'))
      }
    })

    it('enables what applies to an active task', () => {
      expect(enabled(menu(build().template, 'Task'))).toEqual({
        'Pin to top': true,
        'Rename…': true,
        'Mark as unread': true,
        'Mark done': true,
        Reopen: false,
        'Copy link to task': true,
        'Copy outcome': false,
        'Delete task…': true,
      })
    })

    it('enables what applies to a done, pinned task, whose rename its row hides', () => {
      const task: MenuTask = {
        ...TASK,
        pinned: true,
        canRename: false,
        canMarkUnread: false,
        canMarkDone: false,
        canReopen: true,
        canCopyOutcome: true,
      }
      const { template, run } = build({ ...STATE, task })
      const items = menu(template, 'Task')

      expect(enabled(items)).toEqual({
        Unpin: true,
        'Rename…': false,
        'Mark as unread': false,
        'Mark done': false,
        Reopen: true,
        'Copy link to task': true,
        'Copy outcome': true,
        'Delete task…': true,
      })
      click(item(items, 'Reopen'))
      expect(run).toHaveBeenLastCalledWith(taskCommand(TaskCommandId.Reopen, 't1'))
      click(item(items, 'Copy outcome'))
      expect(run).toHaveBeenLastCalledWith(taskCommand(TaskCommandId.CopyOutcome, 't1'))
      click(item(items, 'Mark done'))
      expect(run).toHaveBeenCalledTimes(2)
    })
  })

  it('gives no two of its items the same key but Settings and Workspace settings', () => {
    const keys: string[] = []
    const collect = (items: MenuItemConstructorOptions[]): void => {
      for (const each of items) {
        if (typeof each.accelerator === 'string') keys.push(each.accelerator)
        if (Array.isArray(each.submenu)) collect(each.submenu)
      }
    }
    collect(build().template)

    const repeated = keys.filter((key, index) => keys.indexOf(key) !== index)
    expect(repeated).toEqual(['CmdOrCtrl+,'])
  })

  it('has an item for each command the keymap leaves to the menu bar, with its key', () => {
    const keys = new Map<string, string | undefined>()
    const collect = (items: MenuItemConstructorOptions[]): void => {
      for (const each of items) {
        if (typeof each.id === 'string' && !keys.has(each.id)) keys.set(each.id, each.accelerator)
        if (Array.isArray(each.submenu)) collect(each.submenu)
      }
    }
    collect(build().template)

    for (const { id } of COMMANDS.filter(({ scope }) => scope === KeyScope.MenuBar)) {
      // Switch workspace's are on each workspace's item, the first ⌘1.
      const shown = id === WorkspaceCommandId.Switch ? keys.get(switchItemId('w1')) : keys.get(id)
      expect({ id, key: shown }).toEqual({ id, key: acceleratorOf(DEFAULT_KEYMAP, id, 1) })
    }
  })
})
