import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import {
  appCommand,
  AppCommandId,
  EMPTY_MENU_STATE,
  KEYMAP,
  SWITCH_KEYS,
  switchWorkspaceAccelerator,
  taskCommand,
  TaskCommandId,
  workspaceCommand,
  WorkspaceCommandId,
  type Accelerator,
  type Command,
  type MenuState,
} from '../../shared/commands'
import { TaskActivity, TaskState, UiStateKey, type Task, type UiStateEntry } from '../../shared/domain'
import { taskLink } from '../../shared/taskLink'
import { App } from '../App'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import {
  fakeBridge,
  refuse,
  sampleTask,
  sampleWorkspace,
  type FakeBridge,
  type FakeHandlers,
  type FakeMain,
} from '../store/test-bridge'
import { removeWorkspaceMessage } from './RemoveWorkspaceDialog'

interface Rendered extends FakeBridge {
  readonly store: GladeStore
  readonly main: FakeMain
}

const SHOWING_W1: UiStateEntry[] = [
  { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
  { key: UiStateKey.SelectedTaskId, value: 't1' },
]

/** Three workspaces, w1 (Acme API) shown with its task t1 selected, w2 opened last before it, and w3. */
async function renderApp(main: Partial<FakeMain> = {}, overrides: Partial<FakeHandlers> = {}): Promise<Rendered> {
  const fakeMain: FakeMain = {
    workspaces: [
      { ...sampleWorkspace('w1'), lastOpenedAt: 3_000 },
      { ...sampleWorkspace('w2', 'Glade'), lastOpenedAt: 2_000 },
      { ...sampleWorkspace('w3', 'Dotfiles'), lastOpenedAt: 1_000 },
    ],
    tasks: [
      { ...sampleTask('t1', 'w1', 'Add rate limiting'), status: 'Throttling the public views.' },
      sampleTask('t2', 'w2', 'Draft release notes'),
    ],
    uiState: [...SHOWING_W1],
    menuStates: [],
    revealedWorkspaces: [],
    copied: [],
    workspaceSelections: { w2: 't2' },
    ...main,
  }
  const fake = fakeBridge(fakeMain, overrides)
  const store = createGladeStore(fake.bridge)
  render(
    <GladeStoreProvider store={store}>
      <App />
    </GladeStoreProvider>,
  )
  await act(() => store.getState().hydrate())
  return { ...fake, store, main: fakeMain }
}

/** Chooses a menu bar item: main sends its command to the window. */
function choose({ emit }: FakeBridge, command: Command): void {
  act(() => {
    emit({ type: EventType.MenuCommand, command })
  })
}

function lastMenuState({ main }: Rendered): MenuState | undefined {
  return main.menuStates?.at(-1)
}

function commandsInvoked({ invoke }: FakeBridge): CommandName[] {
  return invoke.mock.calls.map(([command]) => command).filter((command) => command !== CommandName.MenuUpdate)
}

describe('what the menu bar shows', () => {
  it('is reported to main as the window changes: the workspaces, the one shown and the selected task', async () => {
    const rendered = await renderApp({ tasks: [sampleTask('t1', 'w1', '')] })

    await waitFor(() => {
      expect(lastMenuState(rendered)).toEqual({
        workspaces: [
          { id: 'w1', name: 'Acme API' },
          { id: 'w2', name: 'Glade' },
          { id: 'w3', name: 'Dotfiles' },
        ],
        shownWorkspaceId: 'w1',
        task: {
          id: 't1',
          pinned: false,
          canRename: true,
          canMarkUnread: true,
          canMarkDone: false,
          canReopen: false,
          canCopyOutcome: false,
        },
        panels: { sidebar: true, rightPanel: true, bottomBar: true },
      })
    })
    const reports = rendered.main.menuStates?.length ?? 0

    // Nothing the menu bar shows changes: no new report.
    act(() => {
      rendered.store.setState({ searchFocusRequest: 1 })
    })
    expect(rendered.main.menuStates).toHaveLength(reports)

    act(() => {
      rendered.emit({
        type: EventType.TaskUpdated,
        task: { ...sampleTask('t1', 'w1'), title: 'Rate limits', objective: 'Limit it.', status: 'Limited.' },
      })
    })
    await waitFor(() => {
      expect(lastMenuState(rendered)?.task?.canMarkDone).toBe(true)
    })
  })

  it('has nothing to act on in the first-run window but the bottom bar and the workspaces', async () => {
    const rendered = await renderApp({ workspaces: [], tasks: [], uiState: [] })

    await waitFor(() => {
      expect(lastMenuState(rendered)).toEqual({
        ...EMPTY_MENU_STATE,
        panels: { sidebar: false, rightPanel: false, bottomBar: true },
      })
    })
  })

  it('offers a done, pinned task’s reopen and outcome, and no rename while the search hides its row', async () => {
    const done: Task = { ...sampleTask('t1', 'w1'), state: TaskState.Done, pinned: true, doneAt: 3_000 }
    const rendered = await renderApp({ tasks: [done] })
    act(() => {
      rendered.store.getState().setSearchText('rate')
    })

    await waitFor(() => {
      expect(lastMenuState(rendered)?.task).toEqual({
        id: 't1',
        pinned: true,
        canRename: false,
        canMarkUnread: false,
        canMarkDone: false,
        canReopen: true,
        canCopyOutcome: true,
      })
    })
  })
})

describe('the menu bar’s commands', () => {
  it('create a new task, and ask for a folder for a new workspace', async () => {
    const rendered = await renderApp()

    choose(rendered, appCommand(AppCommandId.NewTask))
    await waitFor(() => {
      expect(commandsInvoked(rendered)).toContain(CommandName.TasksCreate)
    })
    choose(rendered, appCommand(AppCommandId.NewWorkspace))
    choose(rendered, appCommand(AppCommandId.OpenFolder))
    await waitFor(() => {
      expect(commandsInvoked(rendered).filter((command) => command === CommandName.DialogChooseFolder)).toHaveLength(2)
    })
  })

  it('open the settings for Settings…, Workspace settings…, Rename workspace… and Change root folder…', async () => {
    const rendered = await renderApp()

    choose(rendered, appCommand(AppCommandId.Settings))
    for (const id of [WorkspaceCommandId.Settings, WorkspaceCommandId.Rename, WorkspaceCommandId.ChangeRoot]) {
      choose(rendered, workspaceCommand(id, 'w1'))
    }

    expect(rendered.store.getState().workspaceSettingsRequest).toBe(4)
  })

  it('switch workspaces, restoring each one’s selection, and reveal the root in Finder', async () => {
    const rendered = await renderApp()

    choose(rendered, workspaceCommand(WorkspaceCommandId.Switch, 'w2'))
    await waitFor(() => {
      expect(rendered.store.getState()).toMatchObject({ selectedWorkspaceId: 'w2', selectedTaskId: 't2' })
    })
    choose(rendered, workspaceCommand(WorkspaceCommandId.RevealRoot, 'w2'))
    await waitFor(() => {
      expect(rendered.main.revealedWorkspaces).toEqual(['w2'])
    })
  })

  it('do nothing for a workspace or task that’s gone', async () => {
    const rendered = await renderApp()

    choose(rendered, workspaceCommand(WorkspaceCommandId.Switch, 'gone'))
    choose(rendered, taskCommand(TaskCommandId.Delete, 'gone'))
    await act(() => Promise.resolve())

    expect(commandsInvoked(rendered)).toEqual([
      CommandName.WorkspacesList,
      CommandName.UiStateGetAll,
      ...listsAndHistory(),
    ])
    expect(rendered.store.getState().deletingTaskId).toBeNull()
  })

  describe('Close workspace', () => {
    it('shows the most recently opened other workspace, with its selection', async () => {
      const rendered = await renderApp()

      choose(rendered, workspaceCommand(WorkspaceCommandId.Close, 'w1'))

      await waitFor(() => {
        expect(rendered.store.getState()).toMatchObject({ selectedWorkspaceId: 'w2', selectedTaskId: 't2' })
      })
      expect(rendered.store.getState().workspaces.map(({ id }) => id)).toEqual(['w1', 'w2', 'w3'])
    })

    it('shows the first-run window when it was the only one, and keeps it there on the next launch', async () => {
      const rendered = await renderApp({ workspaces: [sampleWorkspace('w1')], tasks: [sampleTask('t1', 'w1')] })

      choose(rendered, workspaceCommand(WorkspaceCommandId.Close, 'w1'))

      expect(await screen.findByRole('main', { name: 'Welcome' })).toBeInTheDocument()
      expect(rendered.main.uiState).toEqual(
        expect.arrayContaining([
          { key: UiStateKey.ActiveWorkspaceId, value: '' },
          { key: UiStateKey.SelectedTaskId, value: '' },
        ]),
      )
      const relaunched = createGladeStore(rendered.bridge)
      await relaunched.getState().hydrate()
      expect(relaunched.getState()).toMatchObject({ selectedWorkspaceId: null, selectedTaskId: null })

      choose(rendered, workspaceCommand(WorkspaceCommandId.Switch, 'w1'))
      await waitFor(() => {
        expect(screen.getByRole('navigation', { name: 'Tasks' })).toHaveTextContent('Acme API')
      })
    })

    it('does nothing for a workspace that isn’t shown', async () => {
      const rendered = await renderApp()

      choose(rendered, workspaceCommand(WorkspaceCommandId.Close, 'w2'))
      await act(() => Promise.resolve())

      expect(rendered.store.getState().selectedWorkspaceId).toBe('w1')
    })
  })

  describe('Remove from list…', () => {
    it('asks first, then removes the workspace and its tasks and shows another', async () => {
      const rendered = await renderApp()

      choose(rendered, workspaceCommand(WorkspaceCommandId.Remove, 'w1'))
      const dialog = screen.getByRole('alertdialog', { name: 'Remove “Acme API” from the list?' })
      expect(dialog).toHaveAccessibleDescription(removeWorkspaceMessage(1))
      expect(commandsInvoked(rendered)).not.toContain(CommandName.WorkspacesRemove)
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))

      await waitFor(() => {
        expect(rendered.store.getState()).toMatchObject({ selectedWorkspaceId: 'w2', selectedTaskId: 't2' })
      })
      expect(rendered.store.getState().workspaces.map(({ id }) => id)).toEqual(['w2', 'w3'])
      expect(rendered.store.getState().tasks).not.toHaveProperty('t1')
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })

    it('keeps the workspace when you cancel', async () => {
      const rendered = await renderApp()

      choose(rendered, workspaceCommand(WorkspaceCommandId.Remove, 'w1'))
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(commandsInvoked(rendered)).not.toContain(CommandName.WorkspacesRemove)
    })

    it('shows the first-run window once the last workspace is removed', async () => {
      const rendered = await renderApp({ workspaces: [sampleWorkspace('w1')], tasks: [] })

      choose(rendered, workspaceCommand(WorkspaceCommandId.Remove, 'w1'))
      expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription(removeWorkspaceMessage(0))
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

      expect(await screen.findByRole('main', { name: 'Welcome' })).toBeInTheDocument()
    })

    it('shows a failure as a toast', async () => {
      await renderApp(
        {},
        { [CommandName.WorkspacesRemove]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'The disk is full')) },
      ).then((rendered) => {
        choose(rendered, workspaceCommand(WorkspaceCommandId.Remove, 'w1'))
      })
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

      expect(await screen.findByText('The disk is full')).toBeInTheDocument()
    })
  })

  describe('the Task menu', () => {
    it('pins, marks unread, copies the link and the outcome, and asks before deleting', async () => {
      const rendered = await renderApp()

      choose(rendered, taskCommand(TaskCommandId.TogglePin, 't1'))
      await waitFor(() => {
        expect(rendered.store.getState().tasks.t1?.pinned).toBe(true)
      })
      choose(rendered, taskCommand(TaskCommandId.MarkUnread, 't1'))
      await waitFor(() => {
        expect(rendered.store.getState().tasks.t1?.unread).toBe(true)
      })
      choose(rendered, taskCommand(TaskCommandId.CopyLink, 't1'))
      choose(rendered, taskCommand(TaskCommandId.CopyOutcome, 't1'))
      await waitFor(() => {
        expect(rendered.main.copied).toEqual([taskLink('t1'), 'Throttling the public views.'])
      })
      choose(rendered, taskCommand(TaskCommandId.Delete, 't1'))
      expect(screen.getByRole('alertdialog', { name: 'Delete “Add rate limiting”?' })).toBeInTheDocument()
    })

    it('marks done with the toast’s Undo, and reopens', async () => {
      const ready: Task = { ...sampleTask('t1', 'w1'), objective: 'Limit it.', status: 'Limited.' }
      const rendered = await renderApp({ tasks: [ready] })

      choose(rendered, taskCommand(TaskCommandId.MarkDone, 't1'))
      expect(await screen.findByText(/^Marked done/)).toBeInTheDocument()
      expect(rendered.store.getState().tasks.t1?.state).toBe(TaskState.Done)

      choose(rendered, taskCommand(TaskCommandId.Reopen, 't1'))
      await waitFor(() => {
        expect(rendered.store.getState().tasks.t1?.state).toBe(TaskState.Active)
      })
    })

    it('renames in the task’s row, opening its collapsed section first', async () => {
      const pinned: Task = { ...sampleTask('t1', 'w1'), pinned: true }
      const rendered = await renderApp({
        tasks: [pinned],
        uiState: [...SHOWING_W1, { key: UiStateKey.PinnedSectionCollapsed, value: 'true' }],
      })

      choose(rendered, taskCommand(TaskCommandId.Rename, 't1'))

      expect(rendered.store.getState().renamingTaskId).toBe('t1')
      expect(rendered.store.getState().uiState[UiStateKey.PinnedSectionCollapsed]).toBe('false')
      expect(await screen.findByRole('textbox', { name: 'Task title' })).toHaveFocus()
    })

    it('shows a failure as a toast', async () => {
      const rendered = await renderApp(
        {},
        { [CommandName.TasksUpdate]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No task t1')) },
      )

      choose(rendered, taskCommand(TaskCommandId.TogglePin, 't1'))

      expect(await screen.findByText('No task t1')).toBeInTheDocument()
    })
  })

  describe('Close (⌘W)', () => {
    it('closes the window when nothing that has the focus closes something', async () => {
      const rendered = await renderApp()
      ;(document.activeElement as HTMLElement | null)?.blur()

      choose(rendered, appCommand(AppCommandId.Close))

      await waitFor(() => {
        expect(rendered.main.closedWindows).toBe(1)
      })
    })

    it('closes the file showing, not the window, while the focus is in the right panel’s Files tab', async () => {
      const rendered = await renderApp({
        uiState: [...SHOWING_W1, { key: UiStateKey.RightPanelTab, value: 'files' }],
        openFiles: [{ taskId: 't1', paths: ['api/views.py'], activePath: 'api/views.py' }],
      })
      screen.getByRole('button', { name: 'Close views.py' }).focus()

      choose(rendered, appCommand(AppCommandId.Close))

      await waitFor(() => {
        expect(commandsInvoked(rendered)).toContain(CommandName.FilesClose)
      })
      expect(rendered.main.closedWindows).toBeUndefined()
    })
  })

  it('stop running once the window has gone', async () => {
    const rendered = await renderApp()
    act(() => {
      rendered.store.setState({ hydration: { status: 'loading' } as never })
    })

    choose(rendered, appCommand(AppCommandId.Settings))

    expect(rendered.store.getState().workspaceSettingsRequest).toBe(0)
  })
})

/** Each accelerator as the key press it stands for. */
function keyPress(accelerator: Accelerator): KeyboardEventInit {
  const parts = accelerator.split('+')
  const key = parts[parts.length - 1] ?? ''
  const letter = /^[A-Z]$/.test(key)
  const digit = /^[0-9]$/.test(key)
  return {
    key: letter ? key.toLowerCase() : key,
    code: letter ? `Key${key}` : digit ? `Digit${key}` : key === ',' ? 'Comma' : key,
    metaKey: parts.includes('CmdOrCtrl'),
    shiftKey: parts.includes('Shift'),
    altKey: parts.includes('Alt'),
  }
}

/** Every key the menu bar answers: the keymap's, and ⌘1 – ⌘9. */
const MENU_KEYS: readonly Accelerator[] = [
  ...new Set([
    ...Object.values(KEYMAP),
    ...Array.from({ length: SWITCH_KEYS }, (_, index) => switchWorkspaceAccelerator(index + 1) ?? ''),
  ]),
]

describe('the menu bar’s keys', () => {
  it('are left to the menu bar: the window never takes one, so each runs its command once', async () => {
    const rendered = await renderApp({
      uiState: [...SHOWING_W1, { key: UiStateKey.RightPanelTab, value: 'files' }],
      openFiles: [{ taskId: 't1', paths: ['api/views.py'], activePath: 'api/views.py' }],
    })
    const before = { ...rendered.store.getState(), menuStates: undefined }
    const invoked = commandsInvoked(rendered).length
    // With the focus in the Files tab, where ⌘W closes the file showing: through the menu bar's Close, not the key.
    const target = screen.getByRole('button', { name: 'Close views.py' })
    target.focus()

    for (const accelerator of MENU_KEYS) {
      expect({ accelerator, taken: !fireEvent.keyDown(target, keyPress(accelerator)) }).toEqual({
        accelerator,
        taken: false,
      })
    }
    await act(() => Promise.resolve())

    expect(commandsInvoked(rendered)).toHaveLength(invoked)
    expect(rendered.store.getState()).toMatchObject({
      uiState: before.uiState,
      selectedWorkspaceId: before.selectedWorkspaceId,
      renamingTaskId: null,
      deletingTaskId: null,
    })
  })

  it('include ⌘W, and leave ⌘K alone for the terminal', () => {
    expect(MENU_KEYS).toContain('CmdOrCtrl+W')
    expect(MENU_KEYS.filter((accelerator) => accelerator.endsWith('+K'))).toEqual([])
  })
})

/** What hydrating the three workspaces and loading t1's history invokes. */
function listsAndHistory(): CommandName[] {
  return [CommandName.TasksList, CommandName.TasksList, CommandName.TasksList, CommandName.TasksHistory]
}

// A working task can't be marked done: the menu bar reports it, as the header does.
it('reports that a working task can’t be marked done', async () => {
  const working: Task = {
    ...sampleTask('t1', 'w1'),
    objective: 'Limit it.',
    status: 'Limited.',
    activity: TaskActivity.Working,
  }
  const rendered = await renderApp({ tasks: [working] })

  await waitFor(() => {
    expect(lastMenuState(rendered)?.task?.canMarkDone).toBe(false)
  })
})
