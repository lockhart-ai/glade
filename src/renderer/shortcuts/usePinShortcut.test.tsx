import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../../shared/bridge'
import { UiStateKey, type Task } from '../../shared/domain'
import { ToastProvider } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore } from '../store/store'
import { fakeBridge, refuse, sampleTask, sampleWorkspace, type FakeHandlers } from '../store/test-bridge'
import { usePinShortcut } from './usePinShortcut'

function Harness(): React.JSX.Element {
  usePinShortcut()
  return <textarea aria-label="Message" />
}

const TASK: Task = sampleTask('t1', 'w1', 'Fix flaky login test')

async function renderShortcut(selected = 't1', overrides: Partial<FakeHandlers> = {}) {
  const fake = fakeBridge(
    {
      workspaces: [sampleWorkspace('w1')],
      tasks: [TASK],
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

function pinCalls(invoke: ReturnType<typeof fakeBridge>['invoke']): unknown[] {
  return invoke.mock.calls.filter(([command]) => command === CommandName.TasksUpdate).map(([, request]) => request)
}

/** Presses ⌘⇧P (or a variation of it) on `target`; false when the app took the key. */
function pressPin(target: Window | HTMLElement = window, init: KeyboardEventInit = {}): boolean {
  return fireEvent.keyDown(target, { key: 'P', metaKey: true, shiftKey: true, ...init })
}

describe('usePinShortcut', () => {
  it('pins the selected task on ⌘⇧P, even while typing, and unpins it on the next', async () => {
    const { invoke, store } = await renderShortcut()

    expect(pressPin(screen.getByRole('textbox', { name: 'Message' }))).toBe(false)
    await act(() => Promise.resolve())
    expect(store.getState().tasks.t1?.pinned).toBe(true)

    pressPin(window, { key: 'p' })
    await act(() => Promise.resolve())
    expect(store.getState().tasks.t1?.pinned).toBe(false)

    expect(pinCalls(invoke)).toEqual([
      { id: 't1', patch: { pinned: true } },
      { id: 't1', patch: { pinned: false } },
    ])
  })

  it.each([
    ['no task is selected', ''],
    ['the selected task is gone', 'missing'],
  ])('does nothing when %s', async (_, selected) => {
    const { invoke } = await renderShortcut(selected)

    expect(pressPin()).toBe(false)
    await act(() => Promise.resolve())

    expect(pinCalls(invoke)).toEqual([])
  })

  it.each([
    ['⌘P', { shiftKey: false }],
    ['⇧P', { metaKey: false }],
    ['⌥⌘⇧P', { altKey: true }],
    ['⌃⌘⇧P', { ctrlKey: true }],
    ['⌘⇧O', { key: 'O' }],
  ])('ignores %s', async (_, init) => {
    const { invoke } = await renderShortcut()

    expect(pressPin(window, init)).toBe(true)
    expect(pinCalls(invoke)).toEqual([])
  })

  it('says why when main refuses, in a toast', async () => {
    await renderShortcut('t1', {
      [CommandName.TasksUpdate]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No task t1')),
    })

    pressPin()

    expect(await screen.findByText('No task t1')).toBeInTheDocument()
  })

  it('stops listening once unmounted', async () => {
    const { invoke, view } = await renderShortcut()
    view.unmount()

    pressPin()
    expect(pinCalls(invoke)).toEqual([])
  })
})
