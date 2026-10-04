import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType, type TasksBroadcastResponse } from '../../shared/bridge'
import { BroadcastDelivery, type BroadcastFailed } from '../../shared/broadcast'
import { WindowCommandId } from '../../shared/commands'
import { TaskActivity, TaskState, type Task, type Workspace } from '../../shared/domain'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { TaskIndicator } from '../../shared/taskIndicator'
import { ToastProvider } from '../components'
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
  type FakeMain,
} from '../store/test-bridge'
import { BroadcastDialog } from '.'

const TEXT = "Is anyone restarting Docker? If it's you, stop and tell me why."

const WORKSPACES: Workspace[] = [
  sampleWorkspace('w1', 'Acme API'),
  sampleWorkspace('w2', 'Storefront'),
  sampleWorkspace('w3', 'Docs site'),
]

/**
 * Five active tasks with an agent in two workspaces, one of each standing; two done ones, one of them pinned; and one
 * that has never been given anything, which a broadcast doesn't reach.
 */
const TASKS: Task[] = [
  { ...sampleTask('t1', 'w1', 'Draft release notes for 2.4'), updatedAt: 5_000, sessionId: 's1', unread: true },
  { ...sampleTask('t2', 'w1', 'Move image uploads to S3'), updatedAt: 4_000, activity: TaskActivity.Working },
  { ...sampleTask('t3', 'w1', 'Fix cart total rounding'), updatedAt: 3_000, sessionId: 's3' },
  { ...sampleTask('t4', 'w2', 'Rebuild the checkout page'), updatedAt: 5_000, sessionId: 's4', asking: true },
  { ...sampleTask('t5', 'w2', ''), updatedAt: 4_000, sessionId: 's5' },
  { ...sampleTask('t0', 'w3', ''), updatedAt: 9_000 },
  { ...sampleTask('t6', 'w2', 'Upgrade the payment SDK'), state: TaskState.Done, doneAt: 3_000 },
  { ...sampleTask('t7', 'w3', 'Check for broken links'), state: TaskState.Done, doneAt: 3_000, pinned: true },
]

interface Rendered extends FakeBridge {
  readonly store: GladeStore
}

async function renderDialog(main: Partial<FakeMain> = {}, overrides: Partial<FakeHandlers> = {}): Promise<Rendered> {
  const fake = fakeBridge(
    { workspaces: WORKSPACES, tasks: TASKS.map((task) => ({ ...task })), uiState: [], messages: [], ...main },
    overrides,
  )
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <button type="button">Elsewhere</button>
        <BroadcastDialog />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  return { ...fake, store }
}

async function open(store: GladeStore): Promise<void> {
  act(() => {
    store.getState().openBroadcast()
  })
  await settleFloating()
}

async function renderOpen(main: Partial<FakeMain> = {}, overrides: Partial<FakeHandlers> = {}): Promise<Rendered> {
  const rendered = await renderDialog(main, overrides)
  await open(rendered.store)
  return rendered
}

function field(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Broadcast message' })
}

function type(text: string): void {
  fireEvent.change(field(), { target: { value: text } })
}

/** Presses a key in the message field; answers whether the field kept it (it wasn't the modal's to act on). */
function press(key: string, init: KeyboardEventInit = {}): boolean {
  return fireEvent.keyDown(field(), { key, code: key, ...init })
}

function broadcasts(invoke: FakeBridge['invoke']): unknown[] {
  return invoke.mock.calls.filter(([command]) => command === CommandName.TasksBroadcast).map(([, request]) => request)
}

/** The recipients as the modal lists them: each workspace's name and count, then its tasks' titles and standings. */
function listed(): Record<string, string[]> {
  const groups = within(screen.getByRole('list', { name: 'Recipients' }))
    .getAllByRole('list')
    .map((tasks) => {
      const name = tasks.getAttribute('aria-labelledby') ?? ''
      const heading = document.getElementById(name)?.parentElement?.textContent ?? ''
      const rows = within(tasks)
        .getAllByRole('listitem')
        .map((row) => row.textContent)
      return [heading, rows] as const
    })
  return Object.fromEntries(groups)
}

const settle = (): Promise<void> => act(() => Promise.resolve())

describe('BroadcastDialog', () => {
  it('shows nothing until Broadcast is run', async () => {
    await renderDialog()

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens with the focus in its message field, saying who the message goes to', async () => {
    await renderOpen()

    expect(screen.getByRole('dialog', { name: 'Broadcast' })).toBeInTheDocument()
    expect(field()).toHaveFocus()
    expect(field()).toHaveAttribute('placeholder', 'Message every active task…')
    expect(field()).toHaveValue('')
    expect(
      screen.getByText((_, element) => element?.tagName === 'P' && element.textContent.startsWith('Goes to')),
    ).toHaveTextContent('Goes to 5 active tasks in 2 workspaces. Busy agents get it when their turn ends.')
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
    // No close button: Esc or a click outside closes it.
    expect(
      within(screen.getByRole('dialog'))
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Send'])
  })

  it('lists every active task by workspace, pinned and most recent first, each with where it stands', async () => {
    await renderOpen()

    expect(listed()).toEqual({
      'AAcme API3': [
        'Draft release notes for 2.4needs you',
        'Move image uploads to S3working',
        'Fix cart total roundingidle',
      ],
      // A task its agent hasn't named yet is called what the task list calls it.
      SStorefront2: ['Rebuild the checkout pageneeds you', 'New taskidle'],
    })
    // Done tasks, pinned or not, a task that has never been given anything, and so its workspace, aren't there.
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.queryByText('Upgrade the payment SDK')).not.toBeInTheDocument()
    expect(dialog.queryByText('Docs site')).not.toBeInTheDocument()
    // Read-only: nothing to pick.
    expect(dialog.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('gives each task its dot by the one attention rule: purple needs you, blue working, grey idle', async () => {
    await renderOpen()

    const dots = within(screen.getByRole('list', { name: 'Recipients' }))
      .getAllByRole('listitem')
      .filter((row) => row.dataset.attention !== undefined)
      .map((row) => [row.dataset.attention, row.querySelector('[data-state]')?.getAttribute('data-state')])
    expect(dots).toEqual([
      ['needs_you', TaskIndicator.Waiting],
      ['working', TaskIndicator.Working],
      ['idle', TaskIndicator.Idle],
      ['needs_you', TaskIndicator.Waiting],
      ['idle', TaskIndicator.Idle],
    ])
  })

  it('sends the message to every active task on ↵, and closes', async () => {
    const { invoke, store } = await renderOpen()
    type(TEXT)

    expect(press('Enter')).toBe(false)
    await settle()

    expect(broadcasts(invoke)).toEqual([{ text: TEXT }])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(store.getState().broadcastOpen).toBe(false)
  })

  it('reaches exactly the tasks it listed: the count, the rows and what main sent to agree', async () => {
    let answered: TasksBroadcastResponse | undefined
    const { store } = await renderDialog()
    const original = store.getState().broadcast
    store.setState({
      broadcast: async (text) => {
        const recipients = await original(text)
        answered = { recipients }
        return recipients
      },
    })
    await open(store)
    const rows = Object.values(listed()).flat()
    expect(rows).toHaveLength(5)
    type(TEXT)

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await settle()

    expect(answered?.recipients.map(({ taskId }) => taskId).sort()).toEqual(['t1', 't2', 't3', 't4', 't5'])
    expect(answered?.recipients).toHaveLength(rows.length)
    // The idle ones got it in their chat, as a broadcast; the busy ones in their queue.
    expect(store.getState().messages).toMatchObject({ t3: [{ body: TEXT, broadcast: true }], t5: [{ body: TEXT }] })
    expect(store.getState().queuedMessages).toMatchObject({
      t2: [{ body: TEXT, broadcast: true }],
      t4: [{ body: TEXT, broadcast: true }],
    })
  })

  it('adds a line on ⇧↵, sending nothing', async () => {
    const { invoke } = await renderOpen()
    type(TEXT)

    expect(press('Enter', { shiftKey: true })).toBe(true)
    await settle()

    expect(broadcasts(invoke)).toEqual([])
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('leaves ↵ to the input method while it is composing', async () => {
    const { invoke } = await renderOpen()
    type('ドッカー')

    expect(press('Enter', { isComposing: true })).toBe(true)
    await settle()

    expect(broadcasts(invoke)).toEqual([])
  })

  it('sends on the Send binding you chose, as the input bar does', async () => {
    const { invoke } = await renderOpen({
      settings: { ...DEFAULT_SETTINGS, keyBindings: { [WindowCommandId.Send]: 'Meta+Enter' } },
    })
    type(TEXT)

    expect(press('Enter')).toBe(true)
    await settle()
    expect(broadcasts(invoke)).toEqual([])

    expect(press('Enter', { metaKey: true })).toBe(false)
    await settle()
    expect(broadcasts(invoke)).toEqual([{ text: TEXT }])
  })

  it('sends the message trimmed, and nothing for a blank one', async () => {
    const { invoke } = await renderOpen()

    press('Enter')
    type('  \n ')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await settle()
    expect(broadcasts(invoke)).toEqual([])
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    type(`  ${TEXT}\n`)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await settle()
    expect(broadcasts(invoke)).toEqual([{ text: TEXT }])
  })

  it('closes on Esc without sending, and starts empty when opened again', async () => {
    const { invoke, store } = await renderOpen()
    type(TEXT)

    fireEvent.keyDown(field(), { key: 'Escape' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(broadcasts(invoke)).toEqual([])
    await open(store)
    expect(field()).toHaveValue('')
  })

  it('closes on a click outside it, without sending', async () => {
    const { invoke } = await renderOpen()
    type(TEXT)

    fireEvent.mouseDown(document.body)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(broadcasts(invoke)).toEqual([])
  })

  it('stays open on a click inside it', async () => {
    await renderOpen()

    fireEvent.mouseDown(screen.getByRole('list', { name: 'Recipients' }))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('counts the modal as open, so the input bar holds off taking the focus', async () => {
    const { store } = await renderOpen()
    expect(store.getState().openModalCount).toBe(1)

    fireEvent.keyDown(field(), { key: 'Escape' })

    expect(store.getState().openModalCount).toBe(0)
  })

  describe('with no active task', () => {
    const NONE = TASKS.filter((task) => task.state === TaskState.Done)

    it('says so, and can’t send', async () => {
      const { invoke } = await renderOpen({ tasks: NONE })

      expect(screen.getByText('No active tasks to send to.')).toBeInTheDocument()
      expect(field()).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
      expect(screen.queryByRole('list', { name: 'Recipients' })).not.toBeInTheDocument()
      expect(screen.queryByText(/Goes to/)).not.toBeInTheDocument()

      press('Enter')
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      await settle()
      expect(broadcasts(invoke)).toEqual([])
      // Esc still closes it.
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('says so too when the only active tasks have never been given anything', async () => {
      const { invoke } = await renderOpen({ tasks: [sampleTask('t0', 'w1', ''), sampleTask('t9', 'w2', '')] })

      expect(screen.getByText('No active tasks to send to.')).toBeInTheDocument()
      expect(field()).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
      expect(screen.queryByRole('list', { name: 'Recipients' })).not.toBeInTheDocument()

      press('Enter')
      await settle()
      expect(broadcasts(invoke)).toEqual([])
    })

    it('can send once a task has an agent: its first turn has started', async () => {
      const { emit, invoke } = await renderOpen({ tasks: NONE })

      act(() => {
        // Made, and not yet sent anything: still no one to send to.
        emit({ type: EventType.TaskUpdated, task: sampleTask('t9', 'w3', 'Rewrite the quickstart') })
      })
      expect(field()).toBeDisabled()

      act(() => {
        emit({
          type: EventType.TaskUpdated,
          task: { ...sampleTask('t9', 'w3', 'Rewrite the quickstart'), sessionId: 's9' },
        })
      })

      expect(field()).toBeEnabled()
      expect(listed()).toEqual({ 'DDocs site1': ['Rewrite the quickstartidle'] })
      type(TEXT)
      press('Enter')
      await settle()
      expect(broadcasts(invoke)).toEqual([{ text: TEXT }])
    })
  })

  it('follows the tasks as they change while it is open, keeping what you typed', async () => {
    const { emit } = await renderOpen()
    type(TEXT)
    const [, working, idle] = TASKS

    act(() => {
      // One is marked done, one finishes its turn with a reply you haven't read, and a new one is made.
      emit({ type: EventType.TaskUpdated, task: { ...idle, state: TaskState.Done, doneAt: 6_000 } as Task })
      emit({
        type: EventType.TaskUpdated,
        task: { ...working, activity: TaskActivity.Waiting, sessionId: 's2', unread: true } as Task,
      })
      emit({
        type: EventType.TaskUpdated,
        task: { ...sampleTask('t8', 'w3', 'Rewrite the quickstart'), updatedAt: 7_000, sessionId: 's8' },
      })
    })

    expect(listed()).toEqual({
      'AAcme API2': ['Draft release notes for 2.4needs you', 'Move image uploads to S3needs you'],
      SStorefront2: ['Rebuild the checkout pageneeds you', 'New taskidle'],
      'DDocs site1': ['Rewrite the quickstartidle'],
    })
    expect(screen.getByText(/Goes to/)).toHaveTextContent('Goes to 5 active tasks in 3 workspaces.')
    expect(field()).toHaveValue(TEXT)
  })

  it('says which task couldn’t take it, as a failed send does, and closes: the rest have it', async () => {
    const { store } = await renderOpen(
      {},
      {
        [CommandName.TasksBroadcast]: () => ({
          recipients: [
            { taskId: 't1', delivery: BroadcastDelivery.Sent },
            { taskId: 't2', delivery: BroadcastDelivery.Failed, message: 'spawn claude ENOENT' },
            { taskId: 't3', delivery: BroadcastDelivery.Queued },
          ],
        }),
      },
    )
    type(TEXT)

    press('Enter')
    await settle()

    expect(screen.getByText('Couldn’t send to “Move image uploads to S3”: spawn claude ENOENT')).toBeInTheDocument()
    expect(store.getState().broadcastOpen).toBe(false)
  })

  it('counts the tasks that couldn’t take it when there are several, naming an untitled or deleted one as the list does', async () => {
    const failed = (taskId: string): BroadcastFailed => ({
      taskId,
      delivery: BroadcastDelivery.Failed,
      message: 'spawn claude ENOENT',
    })
    let recipients = [failed('t5'), failed('t1')]
    const { store } = await renderOpen({}, { [CommandName.TasksBroadcast]: () => ({ recipients }) })
    type(TEXT)
    press('Enter')
    await settle()
    expect(screen.getByText('Couldn’t send to 2 tasks.')).toBeInTheDocument()

    // One the agent hasn't named, then one deleted while the broadcast was on its way.
    for (const taskId of ['t5', 'gone']) {
      recipients = [failed(taskId)]
      await open(store)
      type(TEXT)
      press('Enter')
      await settle()
    }
    expect(screen.getAllByText('Couldn’t send to “New task”: spawn claude ENOENT')).toHaveLength(2)
  })

  it('stays open with what you typed when the broadcast fails altogether, to send again', async () => {
    let fail = true
    const { invoke } = await renderOpen(
      {},
      {
        [CommandName.TasksBroadcast]: () =>
          fail
            ? refuse(bridgeError(BridgeErrorCode.Internal, 'tasks.broadcast failed: database is locked'))
            : { recipients: [] },
      },
    )
    type(TEXT)

    press('Enter')
    await settle()

    expect(
      screen.getByText('Couldn’t send your broadcast: tasks.broadcast failed: database is locked'),
    ).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(field()).toHaveValue(TEXT)
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()

    fail = false
    press('Enter')
    await settle()
    expect(broadcasts(invoke)).toHaveLength(2)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('sends once, however many times ↵ is pressed while it is on its way', async () => {
    let answer: (response: TasksBroadcastResponse) => void = () => undefined
    const { invoke } = await renderOpen(
      {},
      {
        [CommandName.TasksBroadcast]: () =>
          new Promise<TasksBroadcastResponse>((resolve) => {
            answer = resolve
          }),
      },
    )
    type(TEXT)

    press('Enter')
    await settle()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    press('Enter')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await settle()

    expect(broadcasts(invoke)).toHaveLength(1)
    await act(async () => {
      answer({ recipients: [] })
      await Promise.resolve()
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
