import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import {
  DividerKind,
  TaskActivity,
  TaskState,
  ToolEventKind,
  UiStateKey,
  type Task,
  type ToolEvent,
} from '../../shared/domain'
import { TaskIndicator } from '../../shared/taskIndicator'
import { DEFAULT_TOAST_TIMEOUT, ToastProvider } from '../components'
import dotStyles from '../components/Dot/Dot.module.css'
import { moduleClass } from '../components/moduleClass'
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
import styles from './SelectedTaskHeader.module.css'
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
  readonly toolEvents?: ToolEvent[]
  readonly panelCollapsed?: boolean
  readonly sidebarCollapsed?: boolean
}

async function renderHeader({
  task = {},
  selected = true,
  overrides = {},
  toolEvents = [],
  panelCollapsed = false,
  sidebarCollapsed = false,
}: Setup = {}): Promise<FakeBridge> {
  const fake = fakeBridge(
    {
      workspaces: [sampleWorkspace('w1')],
      tasks: [{ ...TASK, ...task }],
      toolEvents,
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: selected ? 't1' : '' },
        { key: UiStateKey.RightPanelCollapsed, value: String(panelCollapsed) },
        { key: UiStateKey.SidebarCollapsed, value: String(sidebarCollapsed) },
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

/** The state dot before the title: an image named by the state. (The buttons' icons are hidden from assistive tech.) */
function dot(): HTMLElement {
  return within(header()).getByRole('img')
}

/** The muted age after the title, e.g. `· 42m`. */
function age(): HTMLElement {
  return within(header()).getByText(/^· /)
}

/** How long ago the agent set the status, at the end of the Now row. */
function statusAge(): HTMLElement | null {
  const row = within(header()).queryByRole('group', { name: 'Now' })
  const last = row?.lastElementChild
  return last instanceof HTMLElement && last.tagName === 'SPAN' ? last : null
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

  it('shows an active task’s state dot, title, age, goal, and status with when it changed', async () => {
    await renderHeader()

    expect(within(header()).getByRole('heading', { level: 1 })).toHaveTextContent('Add rate limiting to public API')
    expect(within(header()).getByRole('button', { name: 'Pin task' })).toHaveAttribute('aria-pressed', 'false')
    expect(dot()).toHaveAccessibleName('Active · waiting on you')
    expect(age()).toHaveTextContent(/^· 42m$/)
    expect(field('Goal')).toHaveTextContent(/^Add per-key rate limiting to the public API\.$/)
    expect(field('Now')).toHaveTextContent(/^Throttle applied; 14 new tests pass\.$/)
    expect(statusAge()).toHaveTextContent(/^4m$/)
    expect(within(header()).getByRole('button', { name: 'Mark done' })).toBeInTheDocument()
    // No pill any more: the dot says the state.
    expect(within(header()).queryByRole('status')).toBeNull()
    expect(within(header()).queryByText('Active · waiting on you')).toBeNull()
  })

  it('labels the rows Goal and Now in mono caps, with no Objective or Status', async () => {
    await renderHeader()

    const labels = within(header())
      .getAllByRole('group')
      .map((row) => row.firstElementChild)
    expect(labels.map((label) => label?.textContent)).toEqual(['Goal', 'Now'])
    for (const label of labels) expect(label).toHaveClass(moduleClass(styles, 'label'))
    expect(within(header()).queryByRole('group', { name: 'Objective' })).toBeNull()
    expect(within(header()).queryByRole('group', { name: 'Status' })).toBeNull()
  })

  it('shows a reopened task as reopened, with when it was first done', async () => {
    const divider = (dividerKind: DividerKind, turn: number, createdAt: number): ToolEvent => ({
      id: dividerKind,
      taskId: 't1',
      turn,
      createdAt,
      kind: ToolEventKind.Divider,
      dividerKind,
    })
    await renderHeader({
      task: { activity: TaskActivity.Working },
      toolEvents: [
        divider(DividerKind.MarkedDone, 1, STARTED + 44 * MINUTE),
        divider(DividerKind.Reopened, 2, NOW),
        divider(DividerKind.Turn, 2, NOW),
      ],
    })

    expect(dot()).toHaveAccessibleName('Active · reopened')
    expect(dot()).toHaveAttribute('title', 'Active · reopened')
    expect(dot()).toHaveAttribute('data-state', TaskIndicator.Working)
    expect(age()).toHaveTextContent(/^· 42m$/)
    expect(age()).toHaveAttribute(
      'title',
      'Started Sep 23, 2026, 10:42 AM · first done Sep 23, 2026, 11:26 AM · reopened Sep 23, 2026, 11:24 AM',
    )
    expect(within(header()).getByRole('button', { name: 'Mark done' })).toBeInTheDocument()
  })

  it.each([
    ['working', { activity: TaskActivity.Working }, TaskIndicator.Working, 'Active · working'],
    ['paused', { activity: TaskActivity.Paused }, TaskIndicator.Working, 'Active · paused'],
    ['waiting on you', { activity: TaskActivity.Waiting }, TaskIndicator.Waiting, 'Active · waiting on you'],
    ['stopped by an error', { activity: TaskActivity.Error }, TaskIndicator.Error, 'Active · stopped by an error'],
    [
      'done',
      { state: TaskState.Done, activity: TaskActivity.Waiting, doneAt: STARTED + 44 * MINUTE },
      TaskIndicator.Done,
      'Done · Sep 23',
    ],
    [
      'done while it was stopped by an error',
      { state: TaskState.Done, activity: TaskActivity.Error, doneAt: STARTED + 44 * MINUTE },
      TaskIndicator.Done,
      'Done · Sep 23',
    ],
  ])(
    'colours and names the dot like the sidebar row’s for a task that is %s',
    async (_, task: Partial<Task>, indicator, label) => {
      await renderHeader({ task })

      // The sidebar row's Dot: the same state, so the same colour class.
      expect(dot()).toHaveAttribute('data-state', indicator)
      expect(dot()).toHaveClass(moduleClass(dotStyles, 'dot'), moduleClass(dotStyles, indicator))
      expect(dot()).toHaveClass(moduleClass(styles, 'dot'))
      expect(dot()).toHaveAccessibleName(label)
      expect(dot()).toHaveAttribute('title', label)
      expect(dot()).toBeEmptyDOMElement()
    },
  )

  it('shows a done task’s day, when it ran and its outcome, without Mark done', async () => {
    await renderHeader({ task: { state: TaskState.Done, doneAt: STARTED + 44 * MINUTE } })

    expect(dot()).toHaveAccessibleName('Done · Sep 23')
    expect(age()).toHaveTextContent(/^· 10:42 – 11:26$/)
    expect(age()).toHaveAttribute('title', 'Started Sep 23, 2026, 10:42 AM · done Sep 23, 2026, 11:26 AM')
    expect(field('Outcome')).toHaveTextContent(/^Throttle applied; 14 new tests pass\.$/)
    expect(within(header()).queryByRole('group', { name: 'Now' })).toBeNull()
    expect(within(header()).queryByRole('button', { name: 'Mark done' })).toBeNull()
    // The pin stays; an outcome has no age at the end of its row.
    expect(within(header()).getByRole('button', { name: 'Pin task' })).toBeInTheDocument()
    expect(within(header()).getByRole('group', { name: 'Outcome' }).lastElementChild?.tagName).toBe('P')
  })

  it('shows stand-ins for a new task’s empty fields, without Mark done', async () => {
    await renderHeader({ task: { title: '', objective: '', status: '', statusUpdatedAt: null, createdAt: NOW } })

    expect(within(header()).getByRole('heading', { level: 1 })).toHaveTextContent('New task')
    expect(age()).toHaveTextContent(/^· now$/)
    expect(age()).toHaveAttribute('title', 'Created Sep 23, 2026, 11:24 AM')
    expect(field('Goal')).toHaveTextContent('Set by your first message.')
    expect(field('Now')).toHaveTextContent(/^Nothing yet\.$/)
    expect(statusAge()).toBeNull()
    expect(within(header()).queryByRole('button', { name: 'Mark done' })).toBeNull()
  })

  it('gives the title, goal and status their full text as tooltips, and the age its full date, since they clamp in a small window', async () => {
    await renderHeader()

    expect(age()).toHaveAttribute('title', 'Started Sep 23, 2026, 10:42 AM')
    expect(within(header()).getByRole('heading', { level: 1 })).toHaveAttribute(
      'title',
      'Add rate limiting to public API',
    )
    expect(field('Goal')).toHaveAttribute('title', 'Add per-key rate limiting to the public API.')
    expect(field('Now')).toHaveAttribute('title', 'Throttle applied; 14 new tests pass.')
  })

  it('names the icon-only buttons and gives them tooltips', async () => {
    await renderHeader()

    const pin = within(header()).getByRole('button', { name: 'Pin task' })
    const markDone = within(header()).getByRole('button', { name: 'Mark done' })
    expect(pin).toHaveAttribute('title', 'Pin task')
    expect(markDone).toHaveAttribute('title', 'Mark done')
    // Icon only: no text, just the check in a circle.
    expect(markDone).toHaveTextContent(/^$/)
    expect(markDone.querySelector('svg')).toHaveAttribute('data-icon', 'circle-check')
    expect(pin.querySelector('svg')).toHaveAttribute('data-icon', 'thumbtack')
  })

  it('keeps the buttons in the tab order, as real buttons', async () => {
    await renderHeader()

    for (const name of ['Pin task', 'Mark done']) {
      const button = within(header()).getByRole('button', { name })
      expect(button.tagName).toBe('BUTTON')
      expect(button).toHaveAttribute('type', 'button')
      expect(button).not.toHaveAttribute('tabindex')
      button.focus()
      expect(button).toHaveFocus()
    }
  })

  it('names the pin Unpin task with its tooltip while the task is pinned', async () => {
    await renderHeader({ task: { pinned: true } })

    const unpin = within(header()).getByRole('button', { name: 'Unpin task' })
    expect(unpin).toHaveAttribute('title', 'Unpin task')
    expect(unpin).toHaveAttribute('aria-pressed', 'true')
  })

  it('puts the dot, title and age on one line with the pin and Mark done after them, and the rows below', async () => {
    await renderHeader()

    const title = within(header()).getByRole('heading', { level: 1 })
    const heading = title.parentElement
    const line = heading?.parentElement
    if (!(heading instanceof HTMLElement) || !(line instanceof HTMLElement)) throw new Error('The title has no line')
    expect([...heading.children]).toEqual([dot(), title, age()])
    const pin = within(line).getByRole('button', { name: 'Pin task' })
    const markDone = within(line).getByRole('button', { name: 'Mark done' })
    expect([...line.children]).toEqual([heading, pin, markDone])

    // Neither row is on that line; both come after it, with no divider between.
    const fields = within(header()).getByRole('group', { name: 'Goal' }).parentElement
    expect(fields).toHaveClass(moduleClass(styles, 'fields'))
    expect(fields).not.toHaveClass(moduleClass(styles, 'afterToggle'))
    expect(line.nextElementSibling).toBe(fields)
    expect(within(header()).queryByRole('separator')).toBeNull()
  })

  it('puts the status’s age at the end of the Now row, after the status', async () => {
    await renderHeader()

    const row = within(header()).getByRole('group', { name: 'Now' })
    expect(row.lastElementChild).toBe(statusAge())
    expect(statusAge()).toHaveClass(moduleClass(styles, 'updated'))
    expect(field('Now').compareDocumentPosition(statusAge() as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('gives stand-ins no tooltips', async () => {
    await renderHeader({ task: { title: '', objective: '', status: '', statusUpdatedAt: null, createdAt: NOW } })

    expect(within(header()).getByRole('heading', { level: 1 })).not.toHaveAttribute('title')
    expect(field('Goal')).not.toHaveAttribute('title')
    expect(field('Now')).not.toHaveAttribute('title')
  })

  it('leaves out when the status changed if that isn’t known', async () => {
    await renderHeader({ task: { statusUpdatedAt: null } })

    expect(field('Now')).toHaveTextContent(/^Throttle applied; 14 new tests pass\.$/)
    expect(statusAge()).toBeNull()
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

    expect(await within(header()).findByRole('img', { name: /^Done · / })).toBeInTheDocument()
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
    expect(dot()).toHaveAccessibleName('Active · waiting on you')
    expect(within(header()).getByRole('heading', { level: 1 })).toHaveTextContent('Add rate limiting to public API')
    expect(within(header()).getByRole('button', { name: 'Unpin task' })).toBeInTheDocument()
    expect(field('Goal')).toHaveTextContent('Add per-key rate limiting to the public API.')
    expect(field('Now')).toHaveTextContent(/^Throttle applied; 14 new tests pass\.$/)
    expect(statusAge()).toHaveTextContent('4m')
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
    expect(dot()).toHaveAccessibleName(/^Done · /)
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
    expect(dot()).toHaveAccessibleName(/^Done · /)
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
    expect(dot()).toHaveAccessibleName('Active · waiting on you')
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
    expect(dot()).toHaveAccessibleName('Active · working')
    expect(dot()).toHaveAttribute('data-state', TaskIndicator.Working)
    expect(field('Goal')).toHaveTextContent('Limit each API key.')
    expect(field('Now')).toHaveTextContent(/^Running the tests\.$/)
    expect(statusAge()).toHaveTextContent(/^now$/)
  })

  it('moves its relative times on as time passes', async () => {
    await renderHeader()

    act(() => {
      vi.advanceTimersByTime(2 * NOW_REFRESH_MS)
    })

    expect(age()).toHaveTextContent(/^· 43m$/)
    expect(statusAge()).toHaveTextContent(/^5m$/)
  })

  it('shows the side panel again from a button while it’s collapsed', async () => {
    const { invoke } = await renderHeader({ panelCollapsed: true })

    fireEvent.click(screen.getByRole('button', { name: 'Show side panel' }))

    expect(invoke).toHaveBeenCalledWith(CommandName.UiStateSet, { key: UiStateKey.RightPanelCollapsed, value: 'false' })
    expect(screen.queryByRole('button', { name: 'Show side panel' })).toBeNull()
  })

  it('has no Show side panel button while the panel is open', async () => {
    await renderHeader()

    expect(screen.queryByRole('button', { name: 'Show side panel' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Show task list' })).toBeNull()
  })

  it('shows the task list again from a button before the title while it’s collapsed', async () => {
    const { invoke } = await renderHeader({ sidebarCollapsed: true })

    const show = screen.getByRole('button', { name: 'Show task list' })
    expect(show.compareDocumentPosition(screen.getByRole('heading'))).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    // The rows move over with the title, to stay lined up with it.
    expect(within(header()).getByRole('group', { name: 'Goal' }).parentElement).toHaveClass(
      moduleClass(styles, 'afterToggle'),
    )
    fireEvent.click(show)

    expect(invoke).toHaveBeenCalledWith(CommandName.UiStateSet, { key: UiStateKey.SidebarCollapsed, value: 'false' })
    expect(screen.queryByRole('button', { name: 'Show task list' })).toBeNull()
  })
})
