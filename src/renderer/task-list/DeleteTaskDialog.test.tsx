import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../../shared/bridge'
import { UiStateKey, type Task } from '../../shared/domain'
import { ToastProvider } from '../components'
import { settleFloating } from '../components/settleFloating'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore } from '../store/store'
import { fakeBridge, refuse, sampleTask, sampleWorkspace, type FakeHandlers } from '../store/test-bridge'
import { DELETE_TASK_MESSAGE, DeleteTaskDialog, deleteTaskQuestion, TaskList } from '.'

const TASKS: Task[] = [
  { ...sampleTask('t1', 'w1', 'Fix flaky login test'), updatedAt: 3_000 },
  { ...sampleTask('t2', 'w1', 'Move uploads to S3'), updatedAt: 2_000 },
  { ...sampleTask('t3', 'w1', ''), updatedAt: 1_000 },
]

async function renderDialog(overrides: Partial<FakeHandlers> = {}) {
  const fake = fakeBridge(
    {
      workspaces: [sampleWorkspace('w1')],
      tasks: [...TASKS],
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: 't1' },
      ],
    },
    overrides,
  )
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <TaskList workspaceId="w1" />
        <DeleteTaskDialog />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  return { ...fake, store }
}

async function request(store: Awaited<ReturnType<typeof renderDialog>>['store'], taskId: string): Promise<void> {
  act(() => {
    store.getState().requestDelete(taskId)
  })
  await settleFloating()
}

function deleteCalls(invoke: ReturnType<typeof fakeBridge>['invoke']): unknown[] {
  return invoke.mock.calls.filter(([command]) => command === CommandName.TasksDelete).map(([, request]) => request)
}

describe('DeleteTaskDialog', () => {
  it('shows nothing until a delete is asked for', async () => {
    await renderDialog()

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('asks before deleting, naming the task and what deleting leaves alone', async () => {
    const { store } = await renderDialog()

    await request(store, 't1')

    const dialog = screen.getByRole('alertdialog', { name: 'Delete “Fix flaky login test”?' })
    expect(dialog).toHaveAccessibleDescription(DELETE_TASK_MESSAGE)
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })

  it('keeps the task when cancelled, then deletes it once confirmed, selecting the next task', async () => {
    const { store, invoke } = await renderDialog()
    await request(store, 't1')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(deleteCalls(invoke)).toEqual([])
    expect(screen.getByRole('button', { name: /^Fix flaky login test/ })).toBeInTheDocument()

    await request(store, 't1')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await act(() => Promise.resolve())

    expect(deleteCalls(invoke)).toEqual([{ id: 't1' }])
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Fix flaky login test/ })).not.toBeInTheDocument()
    expect(store.getState().selectedTaskId).toBe('t2')
  })

  it('says why when main refuses, in a toast, and the task stays', async () => {
    const { store } = await renderDialog({
      [CommandName.TasksDelete]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No task t2')),
    })
    await request(store, 't2')

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(await screen.findByText('No task t2')).toBeInTheDocument()
    expect(store.getState().tasks.t2).toBeDefined()
  })

  it('asks about a task without a title yet by what the list calls it', () => {
    expect(deleteTaskQuestion('')).toBe('Delete “New task”?')
  })
})
