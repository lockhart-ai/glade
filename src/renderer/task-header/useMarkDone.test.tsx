import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandName, EventType } from '../../shared/bridge'
import { TaskState, UiStateKey, type Task } from '../../shared/domain'
import { DEFAULT_TOAST_TIMEOUT, type ToastApi, type ToastOptions } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore } from '../store/store'
import { fakeBridge, sampleTask, sampleWorkspace } from '../store/test-bridge'
import { MARKED_DONE_MESSAGE, useMarkDone } from './useMarkDone'

const toastApi = vi.hoisted(() => ({ show: vi.fn<ToastApi['show']>(), dismiss: vi.fn<ToastApi['dismiss']>() }))

vi.mock('../components', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../components')>()),
  useToast: (): ToastApi => toastApi,
}))

const TASK: Task = { ...sampleTask('t1', 'w1', 'Fix flaky login test'), pinned: true }

async function renderMarkDone() {
  const fake = fakeBridge({
    workspaces: [sampleWorkspace('w1')],
    tasks: [{ ...TASK }],
    uiState: [{ key: UiStateKey.ActiveWorkspaceId, value: 'w1' }],
  })
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
    <GladeStoreProvider store={store}>{children}</GladeStoreProvider>
  )
  const { result } = renderHook(() => useMarkDone(), { wrapper })
  await act(() => result.current('t1'))
  return { ...fake, store }
}

/** The options of the mark-done toast (which `show` answers with id 7). */
function markedDoneToast(): ToastOptions {
  const options = toastApi.show.mock.calls
    .map(([shown]) => shown)
    .find((shown) => shown.message === MARKED_DONE_MESSAGE)
  if (options === undefined) throw new Error('No mark-done toast')
  return options
}

/** Main's broadcast of the task back in Active, as when a message reopens it. */
function reopenedEvent() {
  return { type: EventType.TaskUpdated, task: { ...TASK, state: TaskState.Active, doneAt: null } } as const
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  toastApi.show.mockReset().mockReturnValue(7)
  toastApi.dismiss.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useMarkDone', () => {
  it('takes the Undo toast away as soon as the task is reopened some other way', async () => {
    const { emit, store } = await renderMarkDone()
    expect(store.getState().tasks.t1?.state).toBe(TaskState.Done)

    act(() => {
      emit(reopenedEvent())
    })

    expect(toastApi.dismiss).toHaveBeenCalledExactlyOnceWith(7)

    // Once the toast is gone, it stops watching the task.
    act(() => {
      emit({ type: EventType.TaskUpdated, task: { ...TASK, state: TaskState.Done } })
      emit(reopenedEvent())
    })
    expect(toastApi.dismiss).toHaveBeenCalledOnce()
  })

  it('leaves the toast alone while the task stays done', async () => {
    const { emit } = await renderMarkDone()

    act(() => {
      emit({ type: EventType.TaskUpdated, task: { ...TASK, state: TaskState.Done, title: 'Renamed' } })
    })

    expect(toastApi.dismiss).not.toHaveBeenCalled()
  })

  it('stops watching the task once the toast has timed out', async () => {
    const { emit } = await renderMarkDone()

    act(() => {
      vi.advanceTimersByTime(DEFAULT_TOAST_TIMEOUT)
    })
    act(() => {
      emit(reopenedEvent())
    })

    expect(toastApi.dismiss).not.toHaveBeenCalled()
  })

  it('makes Undo do nothing, with no error, once the task is no longer done', async () => {
    const { emit, invoke } = await renderMarkDone()
    act(() => {
      emit(reopenedEvent())
    })
    const { action } = markedDoneToast()
    toastApi.show.mockClear()

    await act(async () => {
      action?.onAction()
      await Promise.resolve()
    })

    expect(invoke).not.toHaveBeenCalledWith(CommandName.TasksReopen, expect.anything())
    expect(toastApi.show).not.toHaveBeenCalled()
  })

  it('reopens the task on Undo while it is still done', async () => {
    const { invoke, store } = await renderMarkDone()

    await act(async () => {
      markedDoneToast().action?.onAction()
      await Promise.resolve()
    })

    expect(invoke).toHaveBeenCalledWith(CommandName.TasksReopen, { id: 't1' })
    expect(store.getState().tasks.t1?.state).toBe(TaskState.Active)
  })
})
