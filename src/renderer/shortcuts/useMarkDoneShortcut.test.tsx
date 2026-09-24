import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../../shared/bridge'
import { TaskActivity, TaskState, UiStateKey, type Task } from '../../shared/domain'
import { ToastProvider } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore } from '../store/store'
import { fakeBridge, refuse, sampleTask, sampleWorkspace, type FakeHandlers } from '../store/test-bridge'
import { MARKED_DONE_MESSAGE } from '../task-header/useMarkDone'
import { useMarkDoneShortcut } from './useMarkDoneShortcut'

function Harness(): React.JSX.Element {
  useMarkDoneShortcut()
  return <textarea aria-label="Message" />
}

const READY: Task = {
  ...sampleTask('t1', 'w1', 'Fix flaky login test'),
  objective: 'Make the login test pass every time.',
  status: 'Found the race; the fix passes 200 local runs.',
}

async function renderShortcut(tasks: Task[] = [READY], selected = 't1', overrides: Partial<FakeHandlers> = {}) {
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

function markDoneCalls(invoke: ReturnType<typeof fakeBridge>['invoke']): unknown[] {
  return invoke.mock.calls.filter(([command]) => command === CommandName.TasksMarkDone).map(([, request]) => request)
}

/** Presses ⌘⇧D (or a variation of it) on `target`; false when the app took the key. */
function pressMarkDone(target: Window | HTMLElement = window, init: KeyboardEventInit = {}): boolean {
  return fireEvent.keyDown(target, { key: 'D', metaKey: true, shiftKey: true, ...init })
}

describe('useMarkDoneShortcut', () => {
  it('marks the selected task done on ⌘⇧D, even while typing, and offers Undo', async () => {
    const { invoke, store } = await renderShortcut()

    expect(pressMarkDone(screen.getByRole('textbox', { name: 'Message' }))).toBe(false)
    await act(() => Promise.resolve())

    expect(markDoneCalls(invoke)).toEqual([{ id: 't1' }])
    expect(store.getState().tasks.t1?.state).toBe(TaskState.Done)
    const toast = screen.getByRole('region', { name: 'Notifications' })
    expect(toast).toHaveTextContent(MARKED_DONE_MESSAGE)

    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }))
    await act(() => Promise.resolve())

    expect(store.getState().tasks.t1).toEqual({ ...READY, doneAt: null })
  })

  it('takes a lowercase d too, as some layouts report it', async () => {
    const { invoke } = await renderShortcut()

    pressMarkDone(window, { key: 'd' })
    await act(() => Promise.resolve())

    expect(markDoneCalls(invoke)).toEqual([{ id: 't1' }])
  })

  it.each([
    ['its agent is working', [{ ...READY, activity: TaskActivity.Working }], 't1'],
    ['it is already done', [{ ...READY, state: TaskState.Done }], 't1'],
    ['it is new', [sampleTask('t1', 'w1', '')], 't1'],
    ['no task is selected', [READY], ''],
  ])('does nothing when %s', async (_, tasks, selected) => {
    const { invoke } = await renderShortcut(tasks, selected)

    expect(pressMarkDone()).toBe(false)
    await act(() => Promise.resolve())

    expect(markDoneCalls(invoke)).toEqual([])
  })

  it.each([
    ['⌘D', { shiftKey: false }],
    ['⇧D', { metaKey: false }],
    ['⌥⌘⇧D', { altKey: true }],
    ['⌃⌘⇧D', { ctrlKey: true }],
    ['⌘⇧E', { key: 'E' }],
  ])('ignores %s', async (_, init) => {
    const { invoke } = await renderShortcut()

    expect(pressMarkDone(window, init)).toBe(true)
    expect(markDoneCalls(invoke)).toEqual([])
  })

  it('says why when main refuses, and offers no Undo', async () => {
    await renderShortcut([READY], 't1', {
      [CommandName.TasksMarkDone]: () => refuse(bridgeError(BridgeErrorCode.InvalidTransition, 'Already done')),
    })

    pressMarkDone()

    expect(await screen.findByText('Already done')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('stops listening once unmounted', async () => {
    const { invoke, view } = await renderShortcut()
    view.unmount()

    pressMarkDone()
    expect(markDoneCalls(invoke)).toEqual([])
  })
})
