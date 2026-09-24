import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CommandName } from '../../shared/bridge'
import { UiStateKey, type Task } from '../../shared/domain'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore } from '../store/store'
import { fakeBridge, sampleTask, sampleWorkspace } from '../store/test-bridge'
import { useMarkUnreadShortcut } from './useMarkUnreadShortcut'

function Harness(): React.JSX.Element {
  useMarkUnreadShortcut()
  return <textarea aria-label="Message" />
}

const READ: Task = { ...sampleTask('t1', 'w1', 'Fix flaky login test'), sessionId: 'session-1' }

async function renderShortcut(tasks: Task[] = [READ], selected = 't1') {
  const fake = fakeBridge({
    workspaces: [sampleWorkspace('w1')],
    tasks: [...tasks],
    uiState: [
      { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
      { key: UiStateKey.SelectedTaskId, value: selected },
    ],
  })
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  const view = render(
    <GladeStoreProvider store={store}>
      <Harness />
    </GladeStoreProvider>,
  )
  return { ...fake, store, view }
}

function unreadCalls(invoke: ReturnType<typeof fakeBridge>['invoke']): unknown[] {
  return invoke.mock.calls.filter(([command]) => command === CommandName.TasksUpdate).map(([, request]) => request)
}

/** Presses ⌘⇧U (or a variation of it) on `target`; false when the app took the key. */
function pressMarkUnread(target: Window | HTMLElement = window, init: KeyboardEventInit = {}): boolean {
  return fireEvent.keyDown(target, { key: 'U', metaKey: true, shiftKey: true, ...init })
}

describe('useMarkUnreadShortcut', () => {
  it('marks the selected task unread on ⌘⇧U, even while typing, and keeps it selected', async () => {
    const { invoke, store } = await renderShortcut()

    expect(pressMarkUnread(screen.getByRole('textbox', { name: 'Message' }))).toBe(false)
    await act(() => Promise.resolve())

    expect(unreadCalls(invoke)).toEqual([{ id: 't1', patch: { unread: true } }])
    expect(store.getState().tasks.t1?.unread).toBe(true)
    expect(store.getState().selectedTaskId).toBe('t1')
  })

  it('takes a lowercase u too, as some layouts report it', async () => {
    const { invoke } = await renderShortcut()

    pressMarkUnread(window, { key: 'u' })
    await act(() => Promise.resolve())

    expect(unreadCalls(invoke)).toEqual([{ id: 't1', patch: { unread: true } }])
  })

  it.each([
    ['the task is already unread', [{ ...READ, unread: true }], 't1'],
    ['no task is selected', [READ], ''],
    ['the selected task is gone', [READ], 'missing'],
  ])('does nothing when %s', async (_, tasks, selected) => {
    const { invoke } = await renderShortcut(tasks, selected)

    expect(pressMarkUnread()).toBe(false)
    await act(() => Promise.resolve())

    expect(unreadCalls(invoke)).toEqual([])
  })

  it.each([
    ['⌘U', { shiftKey: false }],
    ['⇧U', { metaKey: false }],
    ['⌥⌘⇧U', { altKey: true }],
    ['⌃⌘⇧U', { ctrlKey: true }],
    ['⌘⇧I', { key: 'I' }],
  ])('ignores %s', async (_, init) => {
    const { invoke } = await renderShortcut()

    expect(pressMarkUnread(window, init)).toBe(true)
    expect(unreadCalls(invoke)).toEqual([])
  })

  it('stops listening once unmounted', async () => {
    const { invoke, view } = await renderShortcut()
    view.unmount()

    pressMarkUnread()
    expect(unreadCalls(invoke)).toEqual([])
  })
})
