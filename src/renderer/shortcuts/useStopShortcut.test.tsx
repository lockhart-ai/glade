import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../../shared/bridge'
import { TaskActivity, UiStateKey, type Task } from '../../shared/domain'
import { ToastProvider } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore } from '../store/store'
import { fakeBridge, refuse, sampleTask, sampleWorkspace, type FakeHandlers } from '../store/test-bridge'
import { useStopShortcut } from './useStopShortcut'

function Harness(): React.JSX.Element {
  useStopShortcut()
  return <textarea aria-label="Message" />
}

const WORKING: Task = { ...sampleTask('t1', 'w1'), activity: TaskActivity.Working }

async function renderShortcut(tasks: Task[] = [WORKING], selected = 't1', overrides: Partial<FakeHandlers> = {}) {
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

function stopCalls(invoke: ReturnType<typeof fakeBridge>['invoke']): unknown[] {
  return invoke.mock.calls.filter(([command]) => command === CommandName.TasksStop).map(([, request]) => request)
}

describe('useStopShortcut', () => {
  it('stops the selected task on ⌘., even while typing in a text field', async () => {
    const { invoke, store } = await renderShortcut()

    const event = fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: '.', metaKey: true })
    await act(() => Promise.resolve())

    expect(event).toBe(false)
    expect(stopCalls(invoke)).toEqual([{ id: 't1' }])
    expect(store.getState().tasks.t1?.activity).toBe(TaskActivity.Waiting)
  })

  it('does nothing when the selected task is not working, or no task is selected', async () => {
    const idle = await renderShortcut([sampleTask('t1', 'w1')])
    fireEvent.keyDown(window, { key: '.', metaKey: true })
    expect(stopCalls(idle.invoke)).toEqual([])
    idle.view.unmount()

    const none = await renderShortcut([WORKING], '')
    fireEvent.keyDown(window, { key: '.', metaKey: true })
    expect(stopCalls(none.invoke)).toEqual([])
  })

  it('ignores other keys and other modifiers', async () => {
    const { invoke } = await renderShortcut()

    fireEvent.keyDown(window, { key: '.' })
    fireEvent.keyDown(window, { key: ',', metaKey: true })
    fireEvent.keyDown(window, { key: '.', metaKey: true, shiftKey: true })
    fireEvent.keyDown(window, { key: '.', metaKey: true, altKey: true })
    fireEvent.keyDown(window, { key: '.', metaKey: true, ctrlKey: true })

    expect(stopCalls(invoke)).toEqual([])
  })

  it('shows a toast when the agent can’t be stopped', async () => {
    await renderShortcut([WORKING], 't1', {
      [CommandName.TasksStop]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'The session is gone')),
    })

    fireEvent.keyDown(window, { key: '.', metaKey: true })

    expect(await screen.findByText('The session is gone')).toBeInTheDocument()
  })

  it('stops listening once unmounted', async () => {
    const { invoke, view } = await renderShortcut()
    view.unmount()

    fireEvent.keyDown(window, { key: '.', metaKey: true })

    expect(stopCalls(invoke)).toEqual([])
  })
})
