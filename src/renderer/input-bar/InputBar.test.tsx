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
  sampleTask,
  sampleWorkspace,
  type FakeBridge,
  type FakeHandlers,
} from '../store/test-bridge'
import { DONE_PLACEHOLDER, InputBar, NEW_TASK_PLACEHOLDER, REPLY_PLACEHOLDER, sendFailureMessage } from './InputBar'

interface Setup {
  readonly task?: Partial<Task>
  readonly selected?: boolean
  readonly overrides?: Partial<FakeHandlers>
  readonly contextMeter?: React.ReactNode
}

type Rendered = FakeBridge & { store: GladeStore }

async function renderBar({ task = {}, selected = true, overrides = {}, contextMeter }: Setup = {}): Promise<Rendered> {
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
    it('disables Send and shows Stop, but lets you keep typing', async () => {
      const fake = await renderBar()
      setActivity(fake, TaskActivity.Working)
      type('Next, the docs.')

      expect(field()).toBeEnabled()
      expect(sendButton()).toBeDisabled()
      expect(await press('Enter')).toBe(false)
      expect(sends(fake)).toEqual([])
      expect(field()).toHaveValue('Next, the docs.')

      // Stop stops the agent, which goes back to waiting on you.
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
        await Promise.resolve()
      })
      expect(stops(fake)).toEqual([{ id: 't1' }])
      expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
      await press('Enter')
      expect(sends(fake)).toEqual([{ id: 't1', text: 'Next, the docs.' }])
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

describe('sendFailureMessage', () => {
  it('explains a busy agent, and anything else', () => {
    expect(sendFailureMessage(bridgeError(BridgeErrorCode.Busy, 'busy'))).toBe(
      'The agent is still working. Send your message when it finishes.',
    )
    expect(sendFailureMessage(bridgeError(BridgeErrorCode.Internal, 'tasks.send failed: no agent'))).toBe(
      'Couldn’t send your message: tasks.send failed: no agent',
    )
    expect(sendFailureMessage(new Error('offline'))).toBe('Couldn’t send your message: offline')
  })
})
