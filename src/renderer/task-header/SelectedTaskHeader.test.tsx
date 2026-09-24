import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import { TaskActivity, TaskState, UiStateKey, type Task } from '../../shared/domain'
import { DEFAULT_TOAST_TIMEOUT, ToastProvider } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore } from '../store/store'
import {
  fakeBridge,
  refuse,
  sampleTask,
  sampleWorkspace,
  type FakeBridge,
  type FakeHandlers,
} from '../store/test-bridge'
import { NOW_REFRESH_MS } from '../task-list/useNow'
import { SelectedTaskHeader } from './SelectedTaskHeader'
import { MARKED_DONE_MESSAGE } from './useMarkDone'

const MINUTE = 60_000
const STARTED = new Date(2026, 8, 23, 10, 42).getTime()
const NOW = STARTED + 42 * MINUTE

const TASK: Task = {
  ...sampleTask('t1', 'w1', 'Add rate limiting to public API'),
  objective: 'Add per-key rate limiting to the public API.',
  status: 'Throttle applied; 14 new tests pass.',
  statusUpdatedAt: NOW - 4 * MINUTE,
  createdAt: STARTED,
  updatedAt: NOW - 4 * MINUTE,
}

interface Setup {
  readonly task?: Partial<Task>
  readonly selected?: boolean
  readonly overrides?: Partial<FakeHandlers>
}

async function renderHeader({ task = {}, selected = true, overrides = {} }: Setup = {}): Promise<FakeBridge> {
  const fake = fakeBridge(
    {
      workspaces: [sampleWorkspace('w1')],
      tasks: [{ ...TASK, ...task }],
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: selected ? 't1' : '' },
      ],
    },
    overrides,
  )
  const store = createGladeStore(fake.bridge)
  render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <SelectedTaskHeader />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  await act(() => store.getState().hydrate())
  return fake
}

function header(): HTMLElement {
  return screen.getByRole('region', { name: 'Task header' })
}

/** A labelled row's value, e.g. the objective. */
function field(name: string): HTMLElement {
  return within(within(header()).getByRole('group', { name })).getByRole('paragraph')
}

function toasts(): HTMLElement {
  return screen.getByRole('region', { name: 'Notifications' })
}

function pill(): HTMLElement {
  return within(header()).getByRole('status')
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SelectedTaskHeader', () => {
  it('shows nothing while no task is selected', async () => {
    await renderHeader({ selected: false })

    expect(screen.queryByRole('region', { name: 'Task header' })).toBeNull()
  })

  it('shows an active task’s title, pill, start time, objective and status with when it changed', async () => {
    await renderHeader()

    expect(within(header()).getByRole('heading', { level: 1 })).toHaveTextContent('Add rate limiting to public API')
    expect(within(header()).getByRole('button', { name: 'Pin task' })).toHaveAttribute('aria-pressed', 'false')
    expect(pill()).toHaveTextContent('Active · waiting on you')
    expect(header()).toHaveTextContent('started 42m ago')
    expect(field('Objective')).toHaveTextContent('Add per-key rate limiting to the public API.')
    expect(field('Status')).toHaveTextContent('Throttle applied; 14 new tests pass. · 4m ago')
    expect(within(header()).getByRole('button', { name: 'Mark done' })).toBeInTheDocument()
  })

  it.each([
    [TaskActivity.Working, 'Active · working'],
    [TaskActivity.Waiting, 'Active · waiting on you'],
    [TaskActivity.Error, 'Active · stopped by an error'],
  ])('shows the pill for an agent that is %s', async (activity, label) => {
    await renderHeader({ task: { activity } })

    expect(pill()).toHaveTextContent(label)
  })

  it('shows a done task’s day, when it ran and its outcome, without Mark done', async () => {
    await renderHeader({ task: { state: TaskState.Done, doneAt: STARTED + 44 * MINUTE } })

    expect(pill()).toHaveTextContent('Done · Sep 23')
    expect(header()).toHaveTextContent('10:42 – 11:26')
    expect(field('Outcome')).toHaveTextContent(/^Throttle applied; 14 new tests pass\.$/)
    expect(within(header()).queryByRole('group', { name: 'Status' })).toBeNull()
    expect(within(header()).queryByRole('button', { name: 'Mark done' })).toBeNull()
  })

  it('shows stand-ins for a new task’s empty fields, without Mark done', async () => {
    await renderHeader({ task: { title: '', objective: '', status: '', statusUpdatedAt: null, createdAt: NOW } })

    expect(within(header()).getByRole('heading', { level: 1 })).toHaveTextContent('New task')
    expect(header()).toHaveTextContent('created just now')
    expect(field('Objective')).toHaveTextContent('Set by your first message.')
    expect(field('Status')).toHaveTextContent(/^Nothing yet\.$/)
    expect(within(header()).queryByRole('button', { name: 'Mark done' })).toBeNull()
  })

  it('leaves out when the status changed if that isn’t known', async () => {
    await renderHeader({ task: { statusUpdatedAt: null } })

    expect(field('Status')).toHaveTextContent(/^Throttle applied; 14 new tests pass\.$/)
  })

  it('pins and unpins the task', async () => {
    const { invoke } = await renderHeader()

    fireEvent.click(within(header()).getByRole('button', { name: 'Pin task' }))
    const unpin = await within(header()).findByRole('button', { name: 'Unpin task' })
    expect(invoke).toHaveBeenCalledWith(CommandName.TasksUpdate, { id: 't1', patch: { pinned: true } })
    expect(unpin).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(unpin)
    const pin = await within(header()).findByRole('button', { name: 'Pin task' })
    expect(invoke).toHaveBeenCalledWith(CommandName.TasksUpdate, { id: 't1', patch: { pinned: false } })
    expect(pin).toHaveAttribute('aria-pressed', 'false')
  })

  it('marks the task done with no dialog, switches to the done presentation and shows an Undo toast', async () => {
    const { invoke } = await renderHeader()

    fireEvent.click(within(header()).getByRole('button', { name: 'Mark done' }))

    expect(await within(header()).findByText(/^Done · /)).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith(CommandName.TasksMarkDone, { id: 't1' })
    expect(field('Outcome')).toHaveTextContent('Throttle applied; 14 new tests pass.')
    expect(within(header()).queryByRole('button', { name: 'Mark done' })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(await within(toasts()).findByText(MARKED_DONE_MESSAGE)).toBeInTheDocument()
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(CommandName.UiStateSet, {
        key: UiStateKey.DoneSectionCollapsed,
        value: 'false',
      })
    })
  })

  it('leaves Done as it is when the task stays under Pinned', async () => {
    const { invoke } = await renderHeader({ task: { pinned: true } })

    fireEvent.click(within(header()).getByRole('button', { name: 'Mark done' }))

    expect(await within(toasts()).findByText(MARKED_DONE_MESSAGE)).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith(CommandName.UiStateSet, expect.anything())
  })

  it('still offers Undo when Done can’t be expanded, and says why', async () => {
    await renderHeader({
      overrides: { [CommandName.UiStateSet]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'Disk full')) },
    })

    fireEvent.click(within(header()).getByRole('button', { name: 'Mark done' }))

    expect(await screen.findByText('Disk full')).toBeInTheDocument()
    expect(within(toasts()).getByRole('button', { name: 'Undo' })).toBeInTheDocument()
  })

  it('puts the task back exactly as it was on Undo, and takes the toast away', async () => {
    const { invoke } = await renderHeader({ task: { pinned: true } })

    fireEvent.click(within(header()).getByRole('button', { name: 'Mark done' }))
    fireEvent.click(await within(toasts()).findByRole('button', { name: 'Undo' }))

    expect(await within(header()).findByRole('button', { name: 'Mark done' })).toBeEnabled()
    expect(invoke).toHaveBeenCalledWith(CommandName.TasksReopen, { id: 't1' })
    expect(pill()).toHaveTextContent('Active · waiting on you')
    expect(within(header()).getByRole('heading', { level: 1 })).toHaveTextContent('Add rate limiting to public API')
    expect(within(header()).getByRole('button', { name: 'Unpin task' })).toBeInTheDocument()
    expect(field('Objective')).toHaveTextContent('Add per-key rate limiting to the public API.')
    expect(field('Status')).toHaveTextContent('Throttle applied; 14 new tests pass. · 4m ago')
    expect(toasts()).toBeEmptyDOMElement()
  })

  it('says why when Undo fails, leaving the task done', async () => {
    await renderHeader({
      overrides: {
        [CommandName.TasksReopen]: () => refuse(bridgeError(BridgeErrorCode.InvalidTransition, 'Already active')),
      },
    })

    fireEvent.click(within(header()).getByRole('button', { name: 'Mark done' }))
    fireEvent.click(await within(toasts()).findByRole('button', { name: 'Undo' }))

    expect(await screen.findByText('Already active')).toBeInTheDocument()
    expect(pill()).toHaveTextContent(/^Done · /)
  })

  it('takes the Undo toast away after a few seconds, leaving the task done', async () => {
    await renderHeader()
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(NOW)

    fireEvent.click(within(header()).getByRole('button', { name: 'Mark done' }))
    await act(() => Promise.resolve())
    expect(toasts()).toHaveTextContent(MARKED_DONE_MESSAGE)

    act(() => {
      vi.advanceTimersByTime(DEFAULT_TOAST_TIMEOUT)
    })

    expect(toasts()).toBeEmptyDOMElement()
    expect(pill()).toHaveTextContent(/^Done · /)
  })

  it('disables Mark done while the agent is working', async () => {
    const { invoke } = await renderHeader({ task: { activity: TaskActivity.Working } })

    const markDone = within(header()).getByRole('button', { name: 'Mark done' })
    expect(markDone).toBeDisabled()
    fireEvent.click(markDone)

    expect(invoke).not.toHaveBeenCalledWith(CommandName.TasksMarkDone, expect.anything())
  })

  it('says why when main refuses an action', async () => {
    await renderHeader({
      overrides: {
        [CommandName.TasksMarkDone]: () => refuse(bridgeError(BridgeErrorCode.InvalidTransition, 'Already done')),
      },
    })

    fireEvent.click(within(header()).getByRole('button', { name: 'Mark done' }))

    expect(await screen.findByText('Already done')).toBeInTheDocument()
    expect(pill()).toHaveTextContent('Active · waiting on you')
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('says why when main refuses to pin the task', async () => {
    await renderHeader({
      overrides: {
        [CommandName.TasksUpdate]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No task t1')),
      },
    })

    fireEvent.click(within(header()).getByRole('button', { name: 'Pin task' }))

    expect(await screen.findByText('No task t1')).toBeInTheDocument()
  })

  it('follows the task live as the agent changes it', async () => {
    const { emit } = await renderHeader()

    act(() => {
      emit({
        type: EventType.TaskUpdated,
        task: {
          ...TASK,
          title: 'Rate limit the public API',
          objective: 'Limit each API key.',
          status: 'Running the tests.',
          statusUpdatedAt: NOW,
          activity: TaskActivity.Working,
        },
      })
    })

    expect(within(header()).getByRole('heading', { level: 1 })).toHaveTextContent('Rate limit the public API')
    expect(pill()).toHaveTextContent('Active · working')
    expect(field('Objective')).toHaveTextContent('Limit each API key.')
    expect(field('Status')).toHaveTextContent('Running the tests. · just now')
  })

  it('moves its relative times on as time passes', async () => {
    await renderHeader()

    act(() => {
      vi.advanceTimersByTime(2 * NOW_REFRESH_MS)
    })

    expect(header()).toHaveTextContent('started 43m ago')
    expect(field('Status')).toHaveTextContent('· 5m ago')
  })
})
