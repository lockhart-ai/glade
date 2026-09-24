import { describe, expect, it } from 'vitest'
import {
  appCommand,
  AppCommandId,
  CommandScope,
  pinLabel,
  taskCommand,
  TaskCommandId,
  workspaceCommand,
  WorkspaceCommandId,
} from './commands'
import { commandDefinition, DEFAULT_KEYMAP, formatBinding, hasShortcut, KeyScope } from './keymap'

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

describe('the menu bar’s keys', () => {
  it('are the keymap’s defaults for its commands, as docs/keymap.md gives them', () => {
    const ids = [
      AppCommandId.Settings,
      AppCommandId.NewTask,
      AppCommandId.Close,
      AppCommandId.NewWorkspace,
      AppCommandId.OpenFolder,
      AppCommandId.ToggleSidebar,
      AppCommandId.ToggleRightPanel,
      AppCommandId.ToggleBottomBar,
      WorkspaceCommandId.Switch,
      WorkspaceCommandId.Close,
      TaskCommandId.TogglePin,
      TaskCommandId.Rename,
      TaskCommandId.MarkUnread,
      TaskCommandId.MarkDone,
    ] as const
    expect(Object.fromEntries(ids.map((id) => [id, formatBinding(id, DEFAULT_KEYMAP)]))).toEqual({
      [AppCommandId.Settings]: '⌘,',
      [AppCommandId.NewTask]: '⌘N',
      [AppCommandId.Close]: '⌘W',
      [AppCommandId.NewWorkspace]: '⌘⇧N',
      [AppCommandId.OpenFolder]: '⌘O',
      [AppCommandId.ToggleSidebar]: '⌘B',
      [AppCommandId.ToggleRightPanel]: '⌘⌥B',
      [AppCommandId.ToggleBottomBar]: '⌘J',
      [WorkspaceCommandId.Switch]: '⌘1 – ⌘9',
      [WorkspaceCommandId.Close]: '⌘⇧W',
      [TaskCommandId.TogglePin]: '⌘⇧P',
      [TaskCommandId.Rename]: 'F2',
      [TaskCommandId.MarkUnread]: '⌘⇧U',
      [TaskCommandId.MarkDone]: '⌘⇧D',
    })
    for (const id of ids) expect(commandDefinition(id).scope).toBe(KeyScope.MenuBar)
    expect(hasShortcut(TaskCommandId.Reopen)).toBe(false)
    expect(hasShortcut(WorkspaceCommandId.Settings)).toBe(false)
  })
})

it('labels pinning by whether the task is pinned', () => {
  expect(pinLabel(false)).toBe('Pin to top')
  expect(pinLabel(true)).toBe('Unpin')
})
