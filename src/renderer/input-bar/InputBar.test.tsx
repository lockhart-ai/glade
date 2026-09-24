import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import { Effort, MessageRole, TaskActivity, TaskState, UiStateKey, type Task } from '../../shared/domain'
import { ToastProvider } from '../components'
import { settleFloating } from '../components/settleFloating'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import {
  fakeBridge,
  refuse,
  sampleQueuedMessage,
  sampleTask,
  sampleWorkspace,
  type FakeBridge,
  type FakeHandlers,
} from '../store/test-bridge'
import {
  DONE_PLACEHOLDER,
  InputBar,
  NEW_TASK_PLACEHOLDER,
  QUEUE_PLACEHOLDER,
  queueFailureMessage,
  REPLY_PLACEHOLDER,
  sendFailureMessage,
} from './InputBar'

interface Setup {
  readonly task?: Partial<Task>
  readonly selected?: boolean
  readonly overrides?: Partial<FakeHandlers>
  readonly contextMeter?: React.ReactNode
  /** The selected task's queue. */
  readonly queued?: readonly string[]
}

type Rendered = FakeBridge & { store: GladeStore }

async function renderBar({
  task = {},
  selected = true,
  overrides = {},
  contextMeter,
  queued = [],
}: Setup = {}): Promise<Rendered> {
  const fake = fakeBridge(
    {
      workspaces: [sampleWorkspace('w1')],
      tasks: [
        { ...sampleTask('t1', 'w1'), model: 'claude-opus-5-5[1m]', effort: Effort.High, ...task },
        sampleTask('t2', 'w1', 'Fix flaky login test'),
      ],
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: selected ? 't1' : '' },
      ],
      messages: [],
      queuedMessages: queued.map((body, index) => sampleQueuedMessage(`q${String(index + 1)}`, 't1', body)),
    },
    overrides,
  )
  const store = createGladeStore(fake.bridge)
  render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <InputBar contextMeter={contextMeter} />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  await act(() => store.getState().hydrate())
  return { ...fake, store }
}

function field(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: 'Message the agent' })
}

function sendButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Send' })
}

function type(text: string): void {
  fireEvent.change(field(), { target: { value: text } })
}

/** Presses a key in the message field; returns whether the field's default action went ahead. */
async function press(key: string, init: Partial<KeyboardEventInit> = {}): Promise<boolean> {
  let allowed = true
  await act(async () => {
    allowed = fireEvent.keyDown(field(), { key, ...init })
    await Promise.resolve()
  })
  return allowed
}

function sends(fake: FakeBridge): unknown[] {
  return fake.invoke.mock.calls.filter(([command]) => command === CommandName.TasksSend).map(([, request]) => request)
}

function queueAdds(fake: FakeBridge): unknown[] {
  return fake.invoke.mock.calls.filter(([command]) => command === CommandName.QueueAdd).map(([, request]) => request)
}

function queueButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Queue message' })
}

function queueRegion(): HTMLElement {
  return screen.getByRole('region', { name: 'Queued messages' })
}

/** Each queued message's row: its number and text. */
function queueRows(): string[] {
  return within(queueRegion())
    .getAllByRole('listitem')
    .map((row) => row.textContent)
}

function notifications(): HTMLElement {
  return screen.getByRole('region', { name: 'Notifications' })
}

function stops(fake: FakeBridge): unknown[] {
  return fake.invoke.mock.calls.filter(([command]) => command === CommandName.TasksStop).map(([, request]) => request)
}

function updates(fake: FakeBridge): unknown[] {
  return fake.invoke.mock.calls.filter(([command]) => command === CommandName.TasksUpdate).map(([, request]) => request)
}

async function choose(picker: string, option: string): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: picker }))
  await settleFloating()
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitemradio', { name: option }))
    await Promise.resolve()
  })
  await settleFloating()
}

function setActivity(fake: Rendered, activity: TaskActivity): void {
  const task = fake.store.getState().tasks.t1
  if (task === undefined) throw new Error('No task t1')
  act(() => {
    fake.emit({ type: EventType.TaskUpdated, task: { ...task, activity } })
  })
}

describe('InputBar', () => {
  it('shows nothing when no task is selected', async () => {
    await renderBar({ selected: false })

    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('shows the task’s model by name, its effort, Allow all, and the context meter’s slot', async () => {
    await renderBar({ contextMeter: <span>meter</span> })

    expect(screen.getByRole('button', { name: 'Model: Opus 5.5' })).toHaveTextContent('ModelOpus 5.5')
    expect(screen.getByRole('button', { name: 'Effort: High' })).toHaveTextContent('EffortHigh')
    expect(screen.getByRole('button', { name: 'Permissions: Allow all' })).toBeInTheDocument()
    expect(screen.getByTestId('context-meter-slot')).toHaveTextContent('meter')
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('asks a new task for its description, then for replies once it has a message', async () => {
    await renderBar()
    expect(field()).toHaveAttribute('placeholder', NEW_TASK_PLACEHOLDER)

    type('Add rate limiting to the public API.')
    await press('Enter')

    expect(field()).toHaveAttribute('placeholder', REPLY_PLACEHOLDER)
  })

  it('shows a model the picker doesn’t offer by its id', async () => {
    await renderBar({ task: { model: 'claude-sample-1' } })

    expect(screen.getByRole('button', { name: 'Model: claude-sample-1' })).toBeInTheDocument()
  })

  describe('sending', () => {
    it('sends the trimmed message on ↵ and clears the field', async () => {
      const fake = await renderBar()
      type('  Add a Retry-After header.  ')

      expect(await press('Enter')).toBe(false)

      expect(sends(fake)).toEqual([{ id: 't1', text: 'Add a Retry-After header.' }])
      expect(field()).toHaveValue('')
    })

    it('leaves ⇧↵ to the field, which adds a line', async () => {
      const fake = await renderBar()
      type('First line')

      expect(await press('Enter', { shiftKey: true })).toBe(true)
      expect(await press('a')).toBe(true)

      expect(sends(fake)).toEqual([])
      expect(field()).toHaveValue('First line')
    })

    it('doesn’t send while an input method is composing', async () => {
      const fake = await renderBar()
      type('こんにちは')

      expect(await press('Enter', { isComposing: true })).toBe(true)

      expect(sends(fake)).toEqual([])
    })

    it('sends with the Send button, and does nothing for a blank message', async () => {
      const fake = await renderBar()
      type('   ')
      await act(async () => {
        fireEvent.click(sendButton())
        await Promise.resolve()
      })
      expect(sends(fake)).toEqual([])

      type('Ship it.')
      await act(async () => {
        fireEvent.click(sendButton())
        await Promise.resolve()
      })
      expect(sends(fake)).toEqual([{ id: 't1', text: 'Ship it.' }])
    })

    it('sends once while a send is on its way, then lets you send again', async () => {
      let answer: (() => void) | undefined
      const fake = await renderBar({
        overrides: {
          [CommandName.TasksSend]: ({ id, text }) =>
            new Promise((resolve) => {
              answer = () => {
                resolve({
                  message: {
                    id: 'm1',
                    taskId: id,
                    role: MessageRole.User,
                    body: text,
                    turn: 1,
                    createdAt: 1,
                    summary: null,
                  },
                })
              }
            }),
        },
      })
      type('Once.')
      await press('Enter')
      await press('Enter')

      expect(sends(fake)).toHaveLength(1)
      expect(sendButton()).toBeDisabled()
      await act(async () => {
        answer?.()
        await Promise.resolve()
      })
      expect(sendButton()).toBeEnabled()
      expect(field()).toHaveValue('')
    })

    it('sends a done task’s message, which reopens it', async () => {
      const fake = await renderBar({ task: { state: TaskState.Done } })
      expect(field()).toHaveAttribute('placeholder', DONE_PLACEHOLDER)
      type('Also update the docs.')

      await press('Enter')

      expect(sends(fake)).toEqual([{ id: 't1', text: 'Also update the docs.' }])
      expect(field()).toHaveValue('')
    })

    it('keeps the message and says why in a toast when it can’t be sent', async () => {
      const fake = await renderBar({
        overrides: {
          [CommandName.TasksSend]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No task t1')),
        },
      })
      type('Also update the docs.')

      await press('Enter')

      expect(sends(fake)).toHaveLength(1)
      expect(field()).toHaveValue('Also update the docs.')
      expect(screen.getByRole('region', { name: 'Notifications' })).toHaveTextContent(
        'Couldn’t send your message: No task t1',
      )
    })
  })

  describe('while the agent works', () => {
    it('queues what you send instead, with its own placeholder, and shows Stop', async () => {
      const fake = await renderBar()
      setActivity(fake, TaskActivity.Working)
      expect(field()).toHaveAttribute('placeholder', QUEUE_PLACEHOLDER)
      type('Keep the original filenames.')

      expect(queueButton()).toBeEnabled()
      expect(await press('Enter')).toBe(false)
      expect(sends(fake)).toEqual([])
      expect(queueAdds(fake)).toEqual([{ taskId: 't1', text: 'Keep the original filenames.' }])
      expect(field()).toHaveValue('')
      expect(queueRows()).toEqual(['1Keep the original filenames.'])

      type('Then check a sample.')
      await act(async () => {
        fireEvent.click(queueButton())
        await Promise.resolve()
      })
      expect(queueRows()).toEqual(['1Keep the original filenames.', '2Then check a sample.'])
      expect(queueRegion()).toHaveTextContent('Queued · 2Sent when the agent finishes its current step')

      // Stop stops the agent, which goes back to waiting on you; the queue stays, to go with your next message.
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
        await Promise.resolve()
      })
      expect(stops(fake)).toEqual([{ id: 't1' }])
      expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
      expect(queueRegion()).toHaveTextContent('Queued · 2Sent with your next message')
      type('Carry on.')
      await press('Enter')
      expect(sends(fake)).toEqual([{ id: 't1', text: 'Carry on.' }])
    })

    it('queues the message when the agent turns out to be working already', async () => {
      const fake = await renderBar({
        overrides: {
          [CommandName.TasksSend]: () => refuse(bridgeError(BridgeErrorCode.Busy, 'The agent is working')),
        },
      })
      type('Keep the original filenames.')

      await press('Enter')

      expect(sends(fake)).toHaveLength(1)
      expect(queueAdds(fake)).toEqual([{ taskId: 't1', text: 'Keep the original filenames.' }])
      expect(field()).toHaveValue('')
    })

    it('keeps the message and says why in a toast when it can’t be queued', async () => {
      const fake = await renderBar({
        overrides: { [CommandName.QueueAdd]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No task t1')) },
      })
      setActivity(fake, TaskActivity.Working)
      type('Keep the original filenames.')

      await press('Enter')

      expect(field()).toHaveValue('Keep the original filenames.')
      expect(notifications()).toHaveTextContent('Couldn’t send your message: No task t1')
    })

    it('says so in a toast when the agent can’t be stopped', async () => {
      const fake = await renderBar({
        overrides: { [CommandName.TasksStop]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No task t1')) },
      })
      setActivity(fake, TaskActivity.Working)

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
        await Promise.resolve()
      })

      expect(screen.getByRole('region', { name: 'Notifications' })).toHaveTextContent(
        'Couldn’t stop the agent: No task t1',
      )
    })

    it('shows no Stop for a done task whose last activity was working', async () => {
      await renderBar({ task: { state: TaskState.Done, activity: TaskActivity.Working } })

      expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
      expect(sendButton()).toBeEnabled()
    })
  })

  describe('the pickers', () => {
    it('changes the task’s model, with the current one checked', async () => {
      const fake = await renderBar()
      fireEvent.click(screen.getByRole('button', { name: 'Model: Opus 5.5' }))
      await settleFloating()

      const menu = screen.getByRole('menu', { name: 'Model' })
      expect(
        within(menu)
          .getAllByRole('menuitemradio')
          .map((item) => item.textContent),
      ).toEqual(['Opus 5.5', 'Sonnet 5', 'Haiku 4.5'])
      expect(within(menu).getByRole('menuitemradio', { name: 'Opus 5.5' })).toHaveAttribute('aria-checked', 'true')
      fireEvent.keyDown(menu, { key: 'Escape' })
      await settleFloating()

      await choose('Model: Opus 5.5', 'Sonnet 5')

      expect(updates(fake)).toEqual([{ id: 't1', patch: { model: 'claude-sonnet-5' } }])
      expect(screen.getByRole('button', { name: 'Model: Sonnet 5' })).toBeInTheDocument()
    })

    it('changes the task’s effort', async () => {
      const fake = await renderBar()

      await choose('Effort: High', 'Max')

      expect(updates(fake)).toEqual([{ id: 't1', patch: { effort: Effort.Max } }])
      expect(screen.getByRole('button', { name: 'Effort: Max' })).toBeInTheDocument()
    })

    it('does nothing when you choose the current model or effort, or Allow all', async () => {
      const fake = await renderBar()

      await choose('Model: Opus 5.5', 'Opus 5.5')
      await choose('Effort: High', 'High')
      await choose('Permissions: Allow all', 'Allow all')

      expect(updates(fake)).toEqual([])
    })

    it('says so in a toast when a change fails', async () => {
      await renderBar({
        overrides: { [CommandName.TasksUpdate]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No task t1')) },
      })

      await choose('Effort: High', 'Low')

      expect(screen.getByRole('region', { name: 'Notifications' })).toHaveTextContent(
        'Couldn’t change the effort: No task t1',
      )
    })
  })

  it('focuses the message field on ⌘L, and not on other keys', async () => {
    await renderBar()

    fireEvent.keyDown(window, { key: 'l', metaKey: true, shiftKey: true })
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(field()).not.toHaveFocus()

    expect(fireEvent.keyDown(window, { key: 'l', metaKey: true })).toBe(false)
    expect(field()).toHaveFocus()
  })

  it('focuses the field when asked, once per request, even when the request comes as a new task’s bar mounts', async () => {
    const fake = await renderBar()
    expect(field()).not.toHaveFocus()

    act(() => {
      fake.store.getState().focusInput()
    })
    expect(field()).toHaveFocus()
    act(() => {
      field().blur()
    })

    // Selecting a task alone doesn't take the focus; selecting it and asking in one go (as + and ⌘N do) does.
    await act(() => fake.store.getState().selectTask('t2'))
    expect(field()).not.toHaveFocus()
    await act(async () => {
      await fake.store.getState().selectTask('t1')
      fake.store.getState().focusInput()
    })
    expect(field()).toHaveFocus()
  })

  it('starts each task with its own empty draft', async () => {
    const fake = await renderBar()
    type('For the first task')

    await act(() => fake.store.getState().selectTask('t2'))

    expect(field()).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Model: claude-sample-1' })).toBeInTheDocument()
  })
})

describe('the queue', () => {
  const QUEUE = ['Keep the filenames.', 'Use the Glacier storage class.']

  function editor(): HTMLTextAreaElement {
    return screen.getByRole('textbox', { name: 'Queued message' })
  }

  function rowButton(position: number, name: string): HTMLElement {
    const row = within(queueRegion()).getAllByRole('listitem')[position - 1]
    if (row === undefined) throw new Error(`No queued message ${String(position)}`)
    return within(row).getByRole('button', { name })
  }

  async function click(element: HTMLElement): Promise<void> {
    await act(async () => {
      fireEvent.click(element)
      await Promise.resolve()
    })
  }

  async function keyInEditor(key: string, init: Partial<KeyboardEventInit> = {}): Promise<void> {
    await act(async () => {
      fireEvent.keyDown(editor(), { key, ...init })
      await Promise.resolve()
    })
  }

  function edits(fake: FakeBridge): unknown[] {
    return fake.invoke.mock.calls.filter(([command]) => command === CommandName.QueueEdit).map(([, request]) => request)
  }

  it('shows nothing without queued messages', async () => {
    await renderBar()
    expect(screen.queryByRole('region', { name: 'Queued messages' })).toBeNull()
  })

  it('numbers the queued messages in the order they will go', async () => {
    await renderBar({ queued: QUEUE })
    expect(queueRows()).toEqual(['1Keep the filenames.', '2Use the Glacier storage class.'])
    expect(queueRegion()).toHaveTextContent('Queued · 2')
  })

  it('edits a message in place: ↵ saves it, and the message field gets the focus back', async () => {
    const fake = await renderBar({ queued: QUEUE })

    await click(rowButton(1, 'Edit queued message'))
    expect(editor()).toHaveValue('Keep the filenames.')
    expect(editor()).toHaveFocus()
    fireEvent.change(editor(), { target: { value: 'Keep the original filenames in the bucket keys. ' } })
    await keyInEditor('Enter')

    expect(edits(fake)).toEqual([{ id: 'q1', text: 'Keep the original filenames in the bucket keys.' }])
    expect(screen.queryByRole('textbox', { name: 'Queued message' })).toBeNull()
    expect(queueRows()[0]).toBe('1Keep the original filenames in the bucket keys.')
    expect(field()).toHaveFocus()
  })

  it('keeps ⇧↵ and an input method’s ↵ for the editor, and saves with the Save button or on leaving it', async () => {
    const fake = await renderBar({ queued: QUEUE })
    await click(rowButton(2, 'Edit queued message'))
    fireEvent.change(editor(), { target: { value: 'Use Glacier.' } })
    await keyInEditor('Enter', { shiftKey: true })
    await keyInEditor('Enter', { isComposing: true })
    await keyInEditor('a')
    expect(edits(fake)).toEqual([])

    const save = rowButton(2, 'Save queued message')
    expect(fireEvent.mouseDown(save)).toBe(false)
    await click(save)
    expect(edits(fake)).toEqual([{ id: 'q2', text: 'Use Glacier.' }])

    await click(rowButton(1, 'Edit queued message'))
    fireEvent.change(editor(), { target: { value: 'Keep them.' } })
    await act(async () => {
      fireEvent.blur(editor())
      await Promise.resolve()
    })
    expect(edits(fake)).toEqual([
      { id: 'q2', text: 'Use Glacier.' },
      { id: 'q1', text: 'Keep them.' },
    ])
  })

  it('saves nothing for Esc, an unchanged text or a blank one', async () => {
    const fake = await renderBar({ queued: QUEUE })

    await click(rowButton(1, 'Edit queued message'))
    fireEvent.change(editor(), { target: { value: 'Something else.' } })
    await keyInEditor('Escape')
    expect(screen.queryByRole('textbox', { name: 'Queued message' })).toBeNull()
    expect(field()).toHaveFocus()

    await click(rowButton(1, 'Edit queued message'))
    await keyInEditor('Enter')
    await click(rowButton(1, 'Edit queued message'))
    fireEvent.change(editor(), { target: { value: '  ' } })
    await keyInEditor('Enter')

    expect(edits(fake)).toEqual([])
    expect(queueRows()[0]).toBe('1Keep the filenames.')
  })

  it('edits the last queued message on ↑ in the empty message field', async () => {
    await renderBar({ queued: QUEUE })

    expect(await press('ArrowUp', { shiftKey: true })).toBe(true)
    type('Draft')
    expect(await press('ArrowUp')).toBe(true)
    expect(screen.queryByRole('textbox', { name: 'Queued message' })).toBeNull()

    type('')
    expect(await press('ArrowUp')).toBe(false)
    expect(editor()).toHaveValue('Use the Glacier storage class.')
  })

  it('leaves ↑ to the field when nothing is queued', async () => {
    await renderBar()
    expect(await press('ArrowUp')).toBe(true)
  })

  it('removes a message', async () => {
    const fake = await renderBar({ queued: QUEUE })

    await click(rowButton(1, 'Remove queued message'))

    expect(fake.invoke).toHaveBeenLastCalledWith(CommandName.QueueRemove, { id: 'q1' })
    expect(queueRows()).toEqual(['1Use the Glacier storage class.'])
  })

  it('says so in a toast when the agent already has the message being edited or removed', async () => {
    const gone = () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No queued message'))
    await renderBar({
      queued: QUEUE,
      overrides: { [CommandName.QueueEdit]: gone, [CommandName.QueueRemove]: gone },
    })

    await click(rowButton(1, 'Edit queued message'))
    fireEvent.change(editor(), { target: { value: 'Keep them.' } })
    await keyInEditor('Enter')
    expect(notifications()).toHaveTextContent('Couldn’t edit the message: the agent already has it.')

    await click(rowButton(2, 'Remove queued message'))
    expect(notifications()).toHaveTextContent('Couldn’t remove the message: the agent already has it.')
  })

  it('stops editing a message that leaves the queue meanwhile', async () => {
    const fake = await renderBar({ queued: QUEUE })
    await click(rowButton(1, 'Edit queued message'))

    act(() => {
      fake.emit({ type: EventType.QueueChanged, taskId: 't1', queuedMessages: [] })
    })

    expect(screen.queryByRole('region', { name: 'Queued messages' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Queued message' })).toBeNull()
  })
})

describe('queueFailureMessage', () => {
  it('explains a message that has left the queue, and anything else', () => {
    expect(queueFailureMessage('edit', bridgeError(BridgeErrorCode.NotFound, 'No queued message q1'))).toBe(
      'Couldn’t edit the message: the agent already has it.',
    )
    expect(queueFailureMessage('remove', new Error('offline'))).toBe('Couldn’t remove the message: offline')
  })
})

describe('sendFailureMessage', () => {
  it('explains why a message could not be sent', () => {
    expect(sendFailureMessage(bridgeError(BridgeErrorCode.Internal, 'tasks.send failed: no agent'))).toBe(
      'Couldn’t send your message: tasks.send failed: no agent',
    )
    expect(sendFailureMessage(new Error('offline'))).toBe('Couldn’t send your message: offline')
  })
})
