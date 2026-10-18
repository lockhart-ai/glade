import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import { TaskActivity, UiStateKey, type Task } from '../../shared/domain'
import { ToastProvider } from '../components'
import { moduleClass } from '../components/moduleClass'
import { settleFloating } from '../components/settleFloating'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import {
  fakeBridge,
  refuse,
  sampleTask,
  sampleWorkspace,
  type FakeBridge,
  type FakeHandlers,
} from '../store/test-bridge'
import { SettingsSection } from '../settings/sections'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'
import styles from './WorkspaceSwitcher.module.css'

interface Rendered extends FakeBridge {
  readonly store: GladeStore
  readonly revealedWorkspaces: string[]
}

function working(id: string, workspaceId: string): Task {
  return { ...sampleTask(id, workspaceId), activity: TaskActivity.Working, sessionId: 's' }
}

async function renderSwitcher(overrides: Partial<FakeHandlers> = {}): Promise<Rendered> {
  const revealedWorkspaces: string[] = []
  const fake = fakeBridge(
    {
      workspaces: [
        sampleWorkspace('w1', 'Acme API'),
        sampleWorkspace('w2', 'Glade'),
        sampleWorkspace('w3', 'Dotfiles'),
      ],
      tasks: [
        working('t1', 'w1'),
        working('t2', 'w1'),
        working('t3', 'w1'),
        { ...working('t4', 'w2'), activity: TaskActivity.Waiting, unread: true },
      ],
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: 't1' },
      ],
      workspaceSelections: { w2: 't4' },
      revealedWorkspaces,
    },
    overrides,
  )
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <WorkspaceSwitcher />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  return { ...fake, store, revealedWorkspaces }
}

function trigger(): HTMLElement {
  // While the menu is open, it's modal: the rest of the window is hidden from assistive technology.
  return screen.getByRole('button', { name: 'Switch workspace', hidden: true })
}

async function openSwitcher(): Promise<HTMLElement> {
  fireEvent.click(trigger())
  await settleFloating()
  return screen.getByRole('menu', { name: 'Workspaces' })
}

async function choose(name: string): Promise<void> {
  const menu = await openSwitcher()
  fireEvent.click(within(menu).getByRole('menuitem', { name: (accessible) => accessible.startsWith(name) }))
  await act(() => Promise.resolve())
}

describe('WorkspaceSwitcher', () => {
  it('shows the shown workspace in the header, closed until clicked', async () => {
    await renderSwitcher()

    // The header also carries the pill: w2's one unread reply, the only task needing you outside w1.
    expect(screen.getByRole('region', { name: 'Workspace' })).toHaveTextContent('AAcme API/code/w11')
    expect(trigger()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('lists every workspace, oldest first, with its badge, root and status, and a check on the shown one', async () => {
    await renderSwitcher()

    const menu = await openSwitcher()

    expect(trigger()).toHaveAttribute('aria-expanded', 'true')
    expect(within(menu).getByText('Workspaces')).toBeInTheDocument()
    const rows = within(menu).getAllByRole('menuitemradio')
    expect(rows.map((row) => row.textContent)).toEqual([
      'AAcme API/code/w13 active',
      'GGlade/code/w21 needs you',
      'DDotfiles/code/w3idle',
    ])
    expect(rows.map((row) => row.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
    expect(rows[0]?.querySelector('svg')).not.toBeNull()
    expect(rows[1]?.querySelector('svg')).toBeNull()
    expect(rows.map((row) => row.querySelector('[data-tone]')?.getAttribute('data-tone'))).toEqual([
      'blue',
      'purple',
      'teal',
    ])
    // Scoped to the action class: the Needs-you section's task rows (#681) are also `menuitem`s, covered in their
    // own tests.
    const actionClass = moduleClass(styles, 'action')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .filter((item) => item.classList.contains(actionClass))
        .map((item) => item.textContent),
    ).toEqual(['New workspace…⌘⇧N', 'Open folder as workspace…⌘O', 'Workspace settings…⌘,', 'Reveal root in Finder'])
  })

  it('keeps the statuses current as tasks change in the background', async () => {
    const { emit } = await renderSwitcher()
    const menu = await openSwitcher()

    const dotfiles = within(menu).getByRole('menuitemradio', { name: 'Dotfiles' })
    const replied = { ...working('t5', 'w3'), activity: TaskActivity.Waiting, unread: true }
    const update = (task: Task): void => {
      act(() => {
        emit({ type: EventType.TaskUpdated, task })
      })
    }

    // An unread reply needs you, whether or not its subagents still run (#461); read, it's only active.
    update(replied)
    expect(dotfiles).toHaveTextContent('1 needs you')
    update({ ...replied, backgroundWork: true })
    expect(dotfiles).toHaveTextContent('1 needs you')
    update({ ...replied, backgroundWork: true, unread: false })
    expect(dotfiles).toHaveTextContent('1 active')
    update({ ...replied, backgroundWork: false })
    expect(dotfiles).toHaveTextContent('1 needs you')
    update({ ...replied, unread: false })
    expect(dotfiles).toHaveTextContent('1 active')
  })

  it('switches to a workspace, restoring its selection, and closes', async () => {
    const { store, invoke } = await renderSwitcher()
    const menu = await openSwitcher()

    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Glade' }))

    await vi.waitFor(() => {
      expect(store.getState()).toMatchObject({ selectedWorkspaceId: 'w2', selectedTaskId: 't4' })
    })
    expect(invoke).toHaveBeenCalledWith(CommandName.WorkspacesOpen, { id: 'w2' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('region', { name: 'Workspace' })).toHaveTextContent('GGlade/code/w2')
  })

  it('does nothing when choosing the shown workspace', async () => {
    const { invoke } = await renderSwitcher()
    const menu = await openSwitcher()

    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Acme API' }))
    await act(() => Promise.resolve())

    expect(invoke).not.toHaveBeenCalledWith(CommandName.WorkspacesOpen, expect.anything())
  })

  it('closes when the header is clicked again', async () => {
    await renderSwitcher()
    await openSwitcher()

    fireEvent.click(trigger())

    expect(screen.queryByRole('menu')).toBeNull()
  })

  it.each(['New workspace…', 'Open folder as workspace…'])(
    '%s adds the chosen folder as a workspace and opens it',
    async (action) => {
      const { store } = await renderSwitcher({ [CommandName.DialogChooseFolder]: () => ({ path: '/code/blog' }) })

      await choose(action)

      await vi.waitFor(() => {
        expect(store.getState().selectedWorkspaceId).toBe('w4')
      })
      expect(store.getState().workspaces.map(({ rootPath }) => rootPath)).toContain('/code/blog')
    },
  )

  it('opens Settings at the workspace', async () => {
    const { store } = await renderSwitcher()

    await choose('Workspace settings…')

    expect(store.getState().settingsSection).toBe(SettingsSection.Workspace)
  })

  it('reveals the shown workspace’s root in Finder', async () => {
    const { revealedWorkspaces } = await renderSwitcher()

    await choose('Reveal root in Finder')

    expect(revealedWorkspaces).toEqual(['w1'])
  })

  it('shows a toast when an action fails', async () => {
    await renderSwitcher({
      [CommandName.WorkspacesReveal]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No workspace w1')),
    })

    await choose('Reveal root in Finder')

    expect(await screen.findByText('No workspace w1')).toBeInTheDocument()
  })
})

// `needsYouTasks`'s own ordering and its agreement with the menu bar popover is `switcherModel.test.ts`; these cover
// the real switcher's wiring (#681).
describe('the Needs-you section at the top of the menu (#681)', () => {
  /** Minutes ago, for times the rows' own clock shows as these tests expect them. */
  const minutesAgo = (minutes: number): number => Date.now() - minutes * 60_000

  function waitingTask(id: string, workspaceId: string, title: string, minutes: number): Task {
    return {
      ...sampleTask(id, workspaceId, title),
      activity: TaskActivity.Waiting,
      sessionId: 's',
      unread: true,
      updatedAt: minutesAgo(minutes),
    }
  }

  async function renderWithNeeding(overrides: Partial<FakeHandlers> = {}): Promise<Rendered> {
    const revealedWorkspaces: string[] = []
    const fake = fakeBridge(
      {
        workspaces: [
          sampleWorkspace('w1', 'Acme API'),
          sampleWorkspace('w2', 'Acme Web'),
          sampleWorkspace('w3', 'Acme Docs'),
        ],
        tasks: [
          // Six in w1, newest (t1) to oldest (t6): all of them show, none behind a "+N more" row.
          waitingTask('t1', 'w1', 'Add per-key rate limiting', 4),
          waitingTask('t2', 'w1', 'Fix flaky login test', 22),
          waitingTask('t3', 'w1', 'Bump the SDK to 0.4', 38),
          waitingTask('t4', 'w1', 'Clean up the fixtures', 60),
          waitingTask('t5', 'w1', 'Tighten the CORS policy', 90),
          waitingTask('t6', 'w1', 'Rotate the staging key', 130),
          waitingTask('t7', 'w2', 'Redesign the checkout flow', 50),
          // An asking task in w3: its why line is the status the agent set.
          {
            ...sampleTask('t8', 'w3', 'Answer the rate-limit question'),
            activity: TaskActivity.Working,
            sessionId: 's',
            asking: true,
            status: 'Waiting on you: two questions',
            updatedAt: minutesAgo(70),
          },
          working('t9', 'w3'),
        ],
        uiState: [
          { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
          { key: UiStateKey.SelectedTaskId, value: 't1' },
        ],
        workspaceSelections: { w2: 't7' },
        revealedWorkspaces,
      },
      overrides,
    )
    const store = createGladeStore(fake.bridge)
    await act(() => store.getState().hydrate())
    render(
      <GladeStoreProvider store={store}>
        <ToastProvider>
          <WorkspaceSwitcher />
        </ToastProvider>
      </GladeStoreProvider>,
    )
    return { ...fake, store, revealedWorkspaces }
  }

  it('lists every task that needs you across every workspace, newest first, above Workspaces', async () => {
    await renderWithNeeding()
    const menu = await openSwitcher()

    expect(within(menu).getByText('Needs you')).toBeInTheDocument()
    const rows = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent)
    // The tasks, newest change first, across all three workspaces — every one of them, none behind a "+N more" row —
    // then the action rows at the foot. Each task row leads with its workspace badge's initial ("Acme …" → A).
    expect(rows).toEqual([
      'AAdd per-key rate limitingReplied 4m ago4m',
      'AFix flaky login testReplied 22m ago22m',
      'ABump the SDK to 0.4Replied 38m ago38m',
      'ARedesign the checkout flowReplied 50m ago50m',
      'AClean up the fixturesReplied 1h ago1h',
      'AAnswer the rate-limit questionWaiting on you: two questions1h',
      'ATighten the CORS policyReplied 1h 30m ago1h',
      'ARotate the staging keyReplied 2h 10m ago2h',
      'New workspace…⌘⇧N',
      'Open folder as workspace…⌘O',
      'Workspace settings…⌘,',
      'Reveal root in Finder',
    ])
  })

  it('each row shows the workspace’s badge, the title, the purple why line and the time', async () => {
    await renderWithNeeding()
    const menu = await openSwitcher()

    const t1 = within(menu).getByRole('menuitem', { name: 'Add per-key rate limiting' })
    expect(t1.querySelector('[data-tone="blue"]')).not.toBeNull()
    expect(within(t1).getByText('Add per-key rate limiting')).toBeInTheDocument()
    expect(within(t1).getByText('Replied 4m ago')).toBeInTheDocument()
    expect(t1.querySelector('time')).not.toBeNull()
    // The asking task's why line is the status its agent set, as the task list shows it.
    const asking = within(menu).getByRole('menuitem', { name: 'Answer the rate-limit question' })
    expect(within(asking).getByText('Waiting on you: two questions')).toBeInTheDocument()
  })

  it('the workspace rows below keep only their counts: no task rows nest under them', async () => {
    await renderWithNeeding()
    const menu = await openSwitcher()

    const rows = within(menu).getAllByRole('menuitemradio')
    expect(rows.map((row) => row.textContent)).toEqual([
      'AAcme API/code/w16 needs you',
      'AAcme Web/code/w21 needs you',
      'AAcme Docs/code/w31 needs you',
    ])
    expect(within(menu).queryByRole('menuitem', { name: /\+1 more/ })).toBeNull()
  })

  it('is left out entirely when nothing needs you', async () => {
    const { emit } = await renderWithNeeding()
    // Read every reply and answer the one question: nothing needs you anywhere now.
    for (const [id, workspaceId, title, minutes] of [
      ['t1', 'w1', 'Add per-key rate limiting', 4],
      ['t2', 'w1', 'Fix flaky login test', 22],
      ['t3', 'w1', 'Bump the SDK to 0.4', 38],
      ['t4', 'w1', 'Clean up the fixtures', 60],
      ['t5', 'w1', 'Tighten the CORS policy', 90],
      ['t6', 'w1', 'Rotate the staging key', 130],
      ['t7', 'w2', 'Redesign the checkout flow', 50],
    ] as const) {
      act(() => {
        emit({ type: EventType.TaskUpdated, task: { ...waitingTask(id, workspaceId, title, minutes), unread: false } })
      })
    }
    act(() => {
      emit({
        type: EventType.TaskUpdated,
        task: {
          ...sampleTask('t8', 'w3', 'Answer the rate-limit question'),
          activity: TaskActivity.Working,
          sessionId: 's',
        },
      })
    })
    const menu = await openSwitcher()

    expect(within(menu).queryByText('Needs you')).toBeNull()
    expect(
      within(menu)
        .getAllByRole('menuitemradio')
        .map((row) => row.textContent),
    ).toEqual(['AAcme API/code/w16 active', 'AAcme Web/code/w21 active', 'AAcme Docs/code/w32 active'])
  })

  it('a needs-you task switches workspace and selects it in one step, then closes', async () => {
    const { store, invoke } = await renderWithNeeding()
    const menu = await openSwitcher()

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Redesign the checkout flow' }))

    await vi.waitFor(() => {
      expect(store.getState()).toMatchObject({ selectedWorkspaceId: 'w2', selectedTaskId: 't7' })
    })
    expect(invoke).toHaveBeenCalledWith(CommandName.UiStateSet, { key: UiStateKey.SelectedTaskId, value: 't7' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('reaches a task row by arrow keys, and Enter opens it, same as any other row', async () => {
    const { store } = await renderWithNeeding()
    await openSwitcher()
    const key = (name: string): void => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: name })
    }

    // The heading has no row of its own: the first ArrowDown reaches the newest task, t1.
    key('ArrowDown')
    expect(screen.getByRole('menuitem', { name: 'Add per-key rate limiting' })).toHaveFocus()
    key('Enter')

    await vi.waitFor(() => {
      expect(store.getState().selectedTaskId).toBe('t1')
    })
  })

  it('shows a toast when opening a needs-you task fails', async () => {
    await renderWithNeeding({
      [CommandName.UiStateSet]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No task t7')),
    })
    const menu = await openSwitcher()

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Redesign the checkout flow' }))

    expect(await screen.findByText('No task t7')).toBeInTheDocument()
  })

  it('drops a task’s row if it’s deleted while the menu is still open', async () => {
    const { emit } = await renderWithNeeding()
    const menu = await openSwitcher()
    expect(within(menu).getByRole('menuitem', { name: 'Redesign the checkout flow' })).toBeInTheDocument()

    act(() => {
      emit({ type: EventType.TaskDeleted, taskId: 't7' })
    })

    expect(within(menu).queryByRole('menuitem', { name: 'Redesign the checkout flow' })).toBeNull()
    // Acme Web itself, and its still-live rows, are unaffected.
    expect(within(menu).getByRole('menuitemradio', { name: 'Acme Web' })).toBeInTheDocument()
  })

  it('the section keeps itself current while the menu is open: read, a task leaves it', async () => {
    const { emit } = await renderWithNeeding()
    const menu = await openSwitcher()
    expect(within(menu).getByRole('menuitem', { name: 'Redesign the checkout flow' })).toBeInTheDocument()

    act(() => {
      emit({
        type: EventType.TaskUpdated,
        task: { ...waitingTask('t7', 'w2', 'Redesign the checkout flow', 50), unread: false },
      })
    })

    expect(within(menu).queryByRole('menuitem', { name: 'Redesign the checkout flow' })).toBeNull()
  })
})

// The pill's own exhaustive counting (0, 1, 3, 9+, every workspace included) is `switcherModel.test.ts`
// (`needsYouCount`) and `SwitcherAttentionPill.test.tsx`; these cover the real header's wiring.
describe('the "needs you" pill and its tooltip (#472, #480)', () => {
  it('shows the pill and names the count in the header button’s tooltip', async () => {
    await renderSwitcher()

    // w2's one unread reply is the only task that needs you, in this set.
    const region = screen.getByRole('region', { name: 'Workspace' })
    expect(within(region).getByTestId('switcher-pill')).toHaveTextContent('1')
    expect(trigger()).toHaveAttribute('title', 'Switch workspace — 1 task needs you')
  })

  it('still counts a task once its workspace is the one shown: switching alone doesn’t read it (#480)', async () => {
    const { store } = await renderSwitcher()
    const menu = await openSwitcher()

    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Glade' }))
    await vi.waitFor(() => {
      expect(store.getState().selectedWorkspaceId).toBe('w2')
    })

    // w2's task (t4) is now the shown workspace's own, but it hasn't been read: the pill still counts it.
    expect(screen.getByTestId('switcher-pill')).toHaveTextContent('1')
    expect(trigger()).toHaveAttribute('title', 'Switch workspace — 1 task needs you')
  })

  it('hides the pill and resets the tooltip once the task that needed you is read', async () => {
    const { store, emit } = await renderSwitcher()
    const menu = await openSwitcher()

    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Glade' }))
    await vi.waitFor(() => {
      expect(store.getState().selectedWorkspaceId).toBe('w2')
    })

    // Reading it (main marks it read once you open the task) is what actually clears the pill.
    act(() => {
      emit({ type: EventType.TaskUpdated, task: { ...working('t4', 'w2'), activity: TaskActivity.Waiting } })
    })

    expect(screen.queryByTestId('switcher-pill')).toBeNull()
    expect(trigger()).toHaveAttribute('title', 'Switch workspace')
  })

  it('updates live as a task elsewhere starts needing you', async () => {
    const { emit } = await renderSwitcher()
    const replied = { ...working('t5', 'w3'), activity: TaskActivity.Waiting, unread: true }

    act(() => {
      emit({ type: EventType.TaskUpdated, task: replied })
    })

    expect(screen.getByTestId('switcher-pill')).toHaveTextContent('2')
    expect(trigger()).toHaveAttribute('title', 'Switch workspace — 2 tasks need you')
  })
})
