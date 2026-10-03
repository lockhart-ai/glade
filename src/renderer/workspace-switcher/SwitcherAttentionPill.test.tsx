// #472: the closed switcher's own count pill, hidden at 0, capped at "9+", and never counting the open workspace's
// own tasks. The render-count guard is the Performance one from CLAUDE.md: the pill reads its count through its own
// narrow store selector, so it (and only it) renders again when that number changes, and not otherwise.
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EventType } from '../../shared/bridge'
import { TaskActivity, TaskState, UiStateKey, type Task } from '../../shared/domain'
import { sampleTask, sampleWorkspace } from '../store/test-bridge'
import { storeWrapper, type StoreWrapper } from '../store/test-wrapper'
import { SwitcherAttentionPill } from './SwitcherAttentionPill'
import { pillText } from './switcherModel'

// One `pillText` call per render of the pill that shows it (it returns null, without calling pillText, at 0).
vi.mock('./switcherModel', async (importOriginal) => {
  const original = await importOriginal<typeof import('./switcherModel')>()
  return { ...original, pillText: vi.fn(original.pillText) }
})

function renders(): number {
  return vi.mocked(pillText).mock.calls.length
}

/** A task in `workspaceId` with an unread reply: needs you. */
function needsYouTask(id: string, workspaceId: string): Task {
  return { ...sampleTask(id, workspaceId), activity: TaskActivity.Waiting, sessionId: 's', unread: true }
}

async function renderPill(
  workspaces: readonly (readonly [id: string, name: string])[],
  tasks: Task[] = [],
  current = 'w1',
): Promise<StoreWrapper> {
  const wrapper = storeWrapper({
    workspaces: workspaces.map(([id, name]) => sampleWorkspace(id, name)),
    tasks,
    uiState: [{ key: UiStateKey.ActiveWorkspaceId, value: current }],
  })
  render(<SwitcherAttentionPill />, { wrapper: wrapper.wrapper })
  await act(() => wrapper.store.getState().hydrate())
  return wrapper
}

describe('SwitcherAttentionPill', () => {
  it('is hidden with nothing needing you elsewhere', async () => {
    await renderPill(
      [
        ['w1', 'Acme API'],
        ['w2', 'Glade'],
      ],
      [needsYouTask('t1', 'w1')],
    )

    expect(screen.queryByTestId('switcher-pill')).toBeNull()
  })

  it('shows 1 and 3', async () => {
    await renderPill(
      [
        ['w1', 'Acme API'],
        ['w2', 'Glade'],
      ],
      [needsYouTask('t1', 'w2')],
    )
    expect(screen.getByTestId('switcher-pill')).toHaveTextContent('1')

    await renderPill(
      [
        ['w1', 'Acme API'],
        ['w2', 'Glade'],
        ['w3', 'Dotfiles'],
      ],
      [needsYouTask('t1', 'w2'), needsYouTask('t2', 'w3'), needsYouTask('t3', 'w3')],
    )
    expect(screen.getAllByTestId('switcher-pill').at(-1)).toHaveTextContent('3')
  })

  it('never counts the open workspace’s own tasks', async () => {
    await renderPill(
      [
        ['w1', 'Acme API'],
        ['w2', 'Glade'],
      ],
      [needsYouTask('t1', 'w1'), needsYouTask('t2', 'w1'), needsYouTask('t3', 'w2')],
      'w1',
    )

    // Only w2's one task counts; w1's two, the open workspace, never do.
    expect(screen.getByTestId('switcher-pill')).toHaveTextContent('1')
  })

  it('shows 9+ past nine', async () => {
    const many = Array.from({ length: 10 }, (_, index) => needsYouTask(`t${String(index)}`, 'w2'))
    await renderPill(
      [
        ['w1', 'Acme API'],
        ['w2', 'Glade'],
      ],
      many,
    )

    expect(screen.getByTestId('switcher-pill')).toHaveTextContent('9+')
  })

  it('updates live as a task elsewhere starts and stops needing you', async () => {
    const { fake } = await renderPill(
      [
        ['w1', 'Acme API'],
        ['w2', 'Glade'],
      ],
      [],
    )
    expect(screen.queryByTestId('switcher-pill')).toBeNull()

    act(() => {
      fake.emit({ type: EventType.TaskUpdated, task: needsYouTask('t1', 'w2') })
    })
    expect(screen.getByTestId('switcher-pill')).toHaveTextContent('1')

    act(() => {
      fake.emit({ type: EventType.TaskUpdated, task: { ...needsYouTask('t1', 'w2'), unread: false } })
    })
    expect(screen.queryByTestId('switcher-pill')).toBeNull()
  })

  it('renders again only when its own count changes, not on every task update elsewhere', async () => {
    const { fake } = await renderPill(
      [
        ['w1', 'Acme API'],
        ['w2', 'Glade'],
      ],
      [needsYouTask('t1', 'w2')],
    )
    vi.mocked(pillText).mockClear()

    // The same task, changed in a way that doesn't touch its needs-you status: no extra render.
    act(() => {
      fake.emit({ type: EventType.TaskUpdated, task: { ...needsYouTask('t1', 'w2'), status: 'Still checking.' } })
    })
    expect(renders()).toBe(0)
    expect(screen.getByTestId('switcher-pill')).toHaveTextContent('1')

    // A task added in the OPEN workspace that needs you: never counted, so no extra render either.
    act(() => {
      fake.emit({ type: EventType.TaskUpdated, task: needsYouTask('t2', 'w1') })
    })
    expect(renders()).toBe(0)
    expect(screen.getByTestId('switcher-pill')).toHaveTextContent('1')

    // A second task in the other workspace starts needing you: the count actually changes, one more render.
    act(() => {
      fake.emit({ type: EventType.TaskUpdated, task: needsYouTask('t3', 'w2') })
    })
    expect(renders()).toBe(1)
    expect(screen.getByTestId('switcher-pill')).toHaveTextContent('2')

    // Marked done: no longer active, so no longer counted either, even though nothing about "needs you" changed.
    act(() => {
      fake.emit({ type: EventType.TaskUpdated, task: { ...needsYouTask('t3', 'w2'), state: TaskState.Done } })
    })
    expect(screen.getByTestId('switcher-pill')).toHaveTextContent('1')
  })
})
