import { describe, expect, it } from 'vitest'
import {
  appCommand,
  AppCommandId,
  commandHint,
  CommandScope,
  KEYMAP,
  pinLabel,
  shortcutHint,
  switchWorkspaceAccelerator,
  taskCommand,
  TaskCommandId,
  workspaceCommand,
  WorkspaceCommandId,
} from './commands'

describe('commands', () => {
  it('say what they act on', () => {
    expect(appCommand(AppCommandId.NewTask)).toEqual({ scope: CommandScope.App, id: AppCommandId.NewTask })
    expect(workspaceCommand(WorkspaceCommandId.Close, 'w1')).toEqual({
      scope: CommandScope.Workspace,
      id: WorkspaceCommandId.Close,
      workspaceId: 'w1',
    })
    expect(taskCommand(TaskCommandId.MarkDone, 't1')).toEqual({
      scope: CommandScope.Task,
      id: TaskCommandId.MarkDone,
      taskId: 't1',
    })
  })
})

describe('the keymap', () => {
  it('has the keys docs/keymap.md gives the menu bar’s commands', () => {
    expect(Object.fromEntries(Object.entries(KEYMAP).map(([id, keys]) => [id, shortcutHint(keys)]))).toEqual({
      [AppCommandId.Settings]: '⌘,',
      [AppCommandId.NewTask]: '⌘N',
      [AppCommandId.Close]: '⌘W',
      [AppCommandId.NewWorkspace]: '⌘⇧N',
      [AppCommandId.OpenFolder]: '⌘O',
      [AppCommandId.ToggleSidebar]: '⌘B',
      [AppCommandId.ToggleRightPanel]: '⌘⌥B',
      [AppCommandId.ToggleBottomBar]: '⌘J',
      [WorkspaceCommandId.Settings]: '⌘,',
      [WorkspaceCommandId.Close]: '⌘⇧W',
      [TaskCommandId.TogglePin]: '⌘⇧P',
      [TaskCommandId.Rename]: 'F2',
      [TaskCommandId.MarkUnread]: '⌘⇧U',
      [TaskCommandId.MarkDone]: '⌘⇧D',
    })
  })

  it('switches to the first nine workspaces with ⌘1 – ⌘9, and no others', () => {
    expect(switchWorkspaceAccelerator(1)).toBe('CmdOrCtrl+1')
    expect(switchWorkspaceAccelerator(9)).toBe('CmdOrCtrl+9')
    expect(switchWorkspaceAccelerator(0)).toBeUndefined()
    expect(switchWorkspaceAccelerator(10)).toBeUndefined()
    expect(switchWorkspaceAccelerator(1.5)).toBeUndefined()
  })

  it('shows keys with the macOS symbols, and nothing for a command without one', () => {
    expect(shortcutHint('Command+Option+Control+K')).toBe('⌘⌥⌃K')
    expect(shortcutHint('Cmd+Alt+Ctrl+Shift+.')).toBe('⌘⌥⌃⇧.')
    expect(commandHint(TaskCommandId.MarkDone)).toBe('⌘⇧D')
    expect(commandHint(TaskCommandId.Reopen)).toBe('')
  })
})

it('labels pinning by whether the task is pinned', () => {
  expect(pinLabel(false)).toBe('Pin to top')
  expect(pinLabel(true)).toBe('Unpin')
})
