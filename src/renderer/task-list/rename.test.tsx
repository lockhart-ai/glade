// Rename… (Task › Rename…, F2, or a row's menu) and the inline rename it starts in the task list row, together: the
// task's actions, the row's field, and the store.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useEffect } from 'react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../../shared/bridge'
import { TaskState, UiStateKey, type Task, type UiStateEntry } from '../../shared/domain'
import { ToastProvider } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore } from '../store/store'
import { fakeBridge, refuse, sampleTask, sampleWorkspace, type FakeHandlers } from '../store/test-bridge'
import { TaskList } from './TaskList'
import { useTaskActions } from './useTaskActions'

/** Renames the selected task, as the Task menu's Rename… does; set while the harness is rendered. */
let renameSelected: () => void = () => undefined

function Harness({ selected }: { readonly selected: string }): React.JSX.Element {
  const actionsFor = useTaskActions()
  useEffect(() => {
    renameSelected = () => {
      actionsFor(selected)?.rename()
    }
  }, [actionsFor, selected])
  return (
    <>
      <textarea aria-label="Message" />
      <TaskList workspaceId="w1" />
    </>
  )
}

const ACTIVE: Task = { ...sampleTask('t1', 'w1', 'Fix flaky login test'), updatedAt: 2_000 }
const OTHER: Task = { ...sampleTask('t2', 'w1', 'Move uploads to S3'), updatedAt: 1_000 }
const DONE: Task = { ...sampleTask('t3', 'w1', 'Upgrade Django'), state: TaskState.Done, doneAt: 1_500 }

async function renderRename(selected = 't1', uiState: UiStateEntry[] = [], overrides: Partial<FakeHandlers> = {}) {
  const fake = fakeBridge(
    {
      workspaces: [sampleWorkspace('w1')],
      tasks: [ACTIVE, OTHER, DONE],
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: selected },
        ...uiState,
      ],
    },
    overrides,
  )
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  const view = render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <Harness selected={selected} />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  return { ...fake, store, view }
}

function titleCalls(invoke: ReturnType<typeof fakeBridge>['invoke']): unknown[] {
  return invoke.mock.calls
    .filter(
      ([command, request]) => command === CommandName.TasksUpdate && 'patch' in request && 'title' in request.patch,
    )
    .map(([, request]) => request)
}

function field(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('textbox', { name: 'Task title' })
}

/** Chooses Rename… for the selected task. */
function chooseRename(): void {
  act(() => {
    renameSelected()
  })
}

describe('Rename… and the inline rename', () => {
  it("turns the selected task's title into a field holding it, selected, even from the message field", async () => {
    await renderRename()
    screen.getByRole('textbox', { name: 'Message' }).focus()

    chooseRename()

    const input = field()
    expect(input).toHaveValue('Fix flaky login test')
    expect(input).toHaveFocus()
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'Fix flaky login test'.length])
    expect(screen.queryByRole('button', { name: /^Fix flaky login test/ })).not.toBeInTheDocument()
  })

  it('saves the new title, trimmed, on ↵, and the row shows it', async () => {
    const { invoke, store } = await renderRename()
    chooseRename()

    fireEvent.change(field(), { target: { value: '  Fix the login race  ' } })
    fireEvent.keyDown(field(), { key: 'Enter' })
    // Leaving the field as it saves doesn't save it again.
    fireEvent.blur(field())
    await act(() => Promise.resolve())

    expect(titleCalls(invoke)).toEqual([{ id: 't1', patch: { title: 'Fix the login race' } }])
    expect(store.getState().renamingTaskId).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Task title' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Fix the login race/ })).toBeInTheDocument()
  })

  it('cancels on Esc, keeping the title', async () => {
    const { invoke } = await renderRename()
    chooseRename()

    fireEvent.change(field(), { target: { value: 'Something else' } })
    fireEvent.keyDown(field(), { key: 'Escape' })

    expect(screen.queryByRole('textbox', { name: 'Task title' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Fix flaky login test/ })).toBeInTheDocument()
    expect(titleCalls(invoke)).toEqual([])
  })

  it('refuses a blank title on ↵, keeping the field, until you type one', async () => {
    const { invoke } = await renderRename()
    chooseRename()

    fireEvent.change(field(), { target: { value: '   ' } })
    fireEvent.keyDown(field(), { key: 'Enter' })
    await act(() => Promise.resolve())

    expect(field()).toHaveAttribute('aria-invalid', 'true')
    expect(titleCalls(invoke)).toEqual([])

    fireEvent.change(field(), { target: { value: 'Fix the login race' } })
    expect(field()).toHaveAttribute('aria-invalid', 'false')
    fireEvent.keyDown(field(), { key: 'Enter' })
    await act(() => Promise.resolve())

    expect(titleCalls(invoke)).toEqual([{ id: 't1', patch: { title: 'Fix the login race' } }])
  })

  it('saves when the field loses the focus, and cancels then when it is blank', async () => {
    const { invoke } = await renderRename()
    chooseRename()
    fireEvent.change(field(), { target: { value: 'Fix the login race' } })
    fireEvent.blur(field())
    await act(() => Promise.resolve())
    expect(titleCalls(invoke)).toEqual([{ id: 't1', patch: { title: 'Fix the login race' } }])

    chooseRename()
    fireEvent.change(field(), { target: { value: '' } })
    fireEvent.blur(field())

    expect(screen.queryByRole('textbox', { name: 'Task title' })).not.toBeInTheDocument()
    expect(titleCalls(invoke)).toHaveLength(1)
  })

  it('ignores other keys in the field', async () => {
    await renderRename()
    chooseRename()

    fireEvent.keyDown(field(), { key: 'a' })

    expect(field()).toBeInTheDocument()
  })

  it('says why when main refuses the title, in a toast, and stops renaming', async () => {
    await renderRename('t1', [], {
      [CommandName.TasksUpdate]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No task t1')),
    })
    chooseRename()

    fireEvent.change(field(), { target: { value: 'Fix the login race' } })
    fireEvent.keyDown(field(), { key: 'Enter' })

    expect(await screen.findByText('No task t1')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Task title' })).not.toBeInTheDocument()
  })

  it("opens the selected task's collapsed section to show its field", async () => {
    const { store } = await renderRename('t3')

    chooseRename()
    await act(() => Promise.resolve())

    expect(store.getState().uiState[UiStateKey.DoneSectionCollapsed]).toBe('false')
    expect(
      within(screen.getByRole('region', { name: 'Done' })).getByRole('textbox', { name: 'Task title' }),
    ).toHaveValue('Upgrade Django')
  })
})
