import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../../shared/bridge'
import { UiStateKey } from '../../shared/domain'
import { ToastProvider } from '../components'
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
import { NewTaskShortcut } from './useNewTaskShortcut'

interface Rendered extends FakeBridge {
  readonly store: GladeStore
  readonly unmount: () => void
}

async function renderShortcut(overrides: Partial<FakeHandlers> = {}): Promise<Rendered> {
  const fake = fakeBridge(
    {
      workspaces: [sampleWorkspace('w1')],
      tasks: [sampleTask('t1', 'w1', 'Fix flaky login test')],
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: 't1' },
      ],
    },
    overrides,
  )
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  const { unmount } = render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <NewTaskShortcut workspaceId="w1" />
        <textarea aria-label="Message the agent" />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  return { ...fake, store, unmount }
}

/** Presses ⌘N (or a variation of it) in the window; false when the app took the key. */
function pressCommandN(init: KeyboardEventInit = {}): boolean {
  return fireEvent.keyDown(window, { key: 'n', metaKey: true, ...init })
}

describe('⌘N', () => {
  it('creates a task in the workspace, selects it and asks for the input bar’s focus, from anywhere', async () => {
    const { store, invoke } = await renderShortcut()
    screen.getByRole('textbox', { name: 'Message the agent' }).focus()

    expect(pressCommandN()).toBe(false)

    await vi.waitFor(() => {
      expect(store.getState().inputFocusRequest).toBe(1)
    })
    expect(invoke).toHaveBeenCalledWith(CommandName.TasksCreate, { workspaceId: 'w1' })
    const selected = store.getState().selectedTaskId ?? ''
    expect(selected).not.toBe('t1')
    expect(store.getState().tasks[selected]?.title).toBe('')
  })

  it('creates another new task each time, even while an unused one is selected', async () => {
    const { store } = await renderShortcut()

    pressCommandN()
    await vi.waitFor(() => {
      expect(store.getState().inputFocusRequest).toBe(1)
    })
    pressCommandN({ key: 'N' })
    await vi.waitFor(() => {
      expect(store.getState().inputFocusRequest).toBe(2)
    })
    expect(Object.keys(store.getState().tasks)).toHaveLength(3)
  })

  it.each([
    ['N alone', { metaKey: false }],
    ['⌥⌘N', { altKey: true }],
    ['⌃⌘N', { ctrlKey: true }],
    ['⇧⌘N', { shiftKey: true }],
    ['⌘M', { key: 'm' }],
  ])('ignores %s', async (_, init) => {
    const { invoke } = await renderShortcut()
    const calls = invoke.mock.calls.length

    expect(pressCommandN(init)).toBe(true)
    expect(invoke.mock.calls).toHaveLength(calls)
  })

  it('shows a toast when the task can’t be created, and doesn’t ask for the focus', async () => {
    const { store } = await renderShortcut({
      [CommandName.TasksCreate]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No workspace w1')),
    })

    pressCommandN()

    expect(await screen.findByText('No workspace w1')).toBeInTheDocument()
    expect(store.getState().inputFocusRequest).toBe(0)
  })

  it('stops listening once the workspace closes', async () => {
    const { invoke, unmount } = await renderShortcut()
    const calls = invoke.mock.calls.length
    unmount()

    pressCommandN()
    expect(invoke.mock.calls).toHaveLength(calls)
  })
})
