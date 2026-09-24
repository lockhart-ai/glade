import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../../shared/bridge'
import { TaskActivity, TaskState, UiStateKey, type Task } from '../../shared/domain'
import { ToastProvider } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore } from '../store/store'
import { fakeBridge, refuse, sampleTask, sampleWorkspace, type FakeHandlers } from '../store/test-bridge'
import { useCompactShortcut } from './useCompactShortcut'

function Harness(): React.JSX.Element {
  useCompactShortcut()
  return <textarea aria-label="Message" />
}

const IDLE: Task = { ...sampleTask('t1', 'w1'), sessionId: 'session-1', contextUsedTokens: 194_000 }

async function renderShortcut(tasks: Task[] = [IDLE], selected = 't1', overrides: Partial<FakeHandlers> = {}) {
  const fake = fakeBridge(
    {
      workspaces: [sampleWorkspace('w1')],
      tasks: [...tasks],
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: selected },
      ],
    },
    overrides,
  )
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  const view = render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <Harness />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  return { ...fake, store, view }
}

function compactCalls(invoke: ReturnType<typeof fakeBridge>['invoke']): unknown[] {
  return invoke.mock.calls.filter(([command]) => command === CommandName.TasksCompact).map(([, request]) => request)
}

describe('useCompactShortcut', () => {
  it('compacts the selected task on ⌘⇧K, even while typing in a text field', async () => {
    const { invoke, store } = await renderShortcut()

    const event = fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), {
      key: 'K',
      metaKey: true,
      shiftKey: true,
    })
    await act(() => Promise.resolve())

    expect(event).toBe(false)
    expect(compactCalls(invoke)).toEqual([{ id: 't1' }])
    expect(store.getState().tasks.t1?.activity).toBe(TaskActivity.Working)
  })

  it('does nothing while the agent works, for a done task, before a session, or with no task selected', async () => {
    for (const task of [
      { ...IDLE, activity: TaskActivity.Working },
      { ...IDLE, state: TaskState.Done },
      { ...IDLE, sessionId: null },
    ]) {
      const { invoke, view } = await renderShortcut([task])
      fireEvent.keyDown(window, { key: 'k', metaKey: true, shiftKey: true })
      expect(compactCalls(invoke)).toEqual([])
      view.unmount()
    }

    const none = await renderShortcut([IDLE], '')
    fireEvent.keyDown(window, { key: 'k', metaKey: true, shiftKey: true })
    expect(compactCalls(none.invoke)).toEqual([])
  })

  it('ignores other keys and other modifiers', async () => {
    const { invoke } = await renderShortcut()

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    fireEvent.keyDown(window, { key: 'j', metaKey: true, shiftKey: true })
    fireEvent.keyDown(window, { key: 'k', metaKey: true, shiftKey: true, altKey: true })
    fireEvent.keyDown(window, { key: 'k', metaKey: true, shiftKey: true, ctrlKey: true })

    expect(compactCalls(invoke)).toEqual([])
  })

  it('shows a toast when main refuses', async () => {
    await renderShortcut([IDLE], 't1', {
      [CommandName.TasksCompact]: () => refuse(bridgeError(BridgeErrorCode.Busy, 'The agent is working')),
    })

    fireEvent.keyDown(window, { key: 'k', metaKey: true, shiftKey: true })

    expect(await screen.findByText('The agent is working')).toBeInTheDocument()
  })

  it('stops listening once unmounted', async () => {
    const { invoke, view } = await renderShortcut()
    view.unmount()

    fireEvent.keyDown(window, { key: 'k', metaKey: true, shiftKey: true })

    expect(compactCalls(invoke)).toEqual([])
  })
})
