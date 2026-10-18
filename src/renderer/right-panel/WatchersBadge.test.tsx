// #687: the Agents tab's own eye and count, after its agent count, hidden at 0. The render-count guard is the
// Performance one from CLAUDE.md: the badge reads its count through its own narrow store selector, so it (and only
// it) renders again when that number changes, and not otherwise.
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EventType } from '../../shared/bridge'
import { UiStateKey, WatcherState, type Watcher } from '../../shared/domain'
import { storeWrapper, type StoreWrapper } from '../store/test-wrapper'
import { sampleWatcher } from '../store/test-bridge'
import { watchingLabel } from '../watchers/watchersModel'
import { WatchersBadge } from './WatchersBadge'

// One `watchingLabel` call per render of the badge that shows it (it returns null, without calling it, at 0).
vi.mock('../watchers/watchersModel', async (importOriginal) => {
  const original = await importOriginal<typeof import('../watchers/watchersModel')>()
  return { ...original, watchingLabel: vi.fn(original.watchingLabel) }
})

function renders(): number {
  return vi.mocked(watchingLabel).mock.calls.length
}

const running = (id: string, overrides: Partial<Watcher> = {}): Watcher =>
  sampleWatcher(id, 't1', { label: `Watch ${id}`, ...overrides })

/** `t1` selected, with `watchers` as its stored watchers (every task's live ones load on start). */
async function renderBadge(watchers: Watcher[], taskId = 't1'): Promise<StoreWrapper> {
  const wrapper = storeWrapper({
    uiState: [{ key: UiStateKey.SelectedTaskId, value: taskId }],
    watchers,
  })
  render(<WatchersBadge taskId={taskId} />, { wrapper: wrapper.wrapper })
  await act(() => wrapper.store.getState().hydrate())
  return wrapper
}

describe('WatchersBadge', () => {
  it('is hidden with no watchers', async () => {
    await renderBadge([])

    expect(screen.queryByRole('img')).toBeNull()
  })

  it('is hidden with only ended watchers', async () => {
    await renderBadge([
      running('done', { state: WatcherState.Finished, outcome: 'It passed.' }),
      running('stopped', { state: WatcherState.Stopped, outcome: 'Stopped by you.' }),
    ])

    expect(screen.queryByRole('img')).toBeNull()
  })

  it('shows how many are live, named for a screen reader and on hover, as the sidebar row does', async () => {
    await renderBadge([running('ci'), running('rollout')])

    const badge = screen.getByRole('img', { name: '2 watchers running' })
    expect(badge).toHaveTextContent('2')
    expect(badge).toHaveAttribute('title', '2 watchers running')
  })

  it('counts only the live ones among ended ones', async () => {
    await renderBadge([running('ci'), running('old', { state: WatcherState.Finished, outcome: 'It passed.' })])

    expect(screen.getByRole('img', { name: '1 watcher running' })).toHaveTextContent('1')
  })

  it('updates live as watchers start and end', async () => {
    const { fake } = await renderBadge([])
    expect(screen.queryByRole('img')).toBeNull()

    act(() => {
      fake.emit({ type: EventType.WatchersChanged, taskId: 't1', watchers: [running('ci')] })
    })
    expect(screen.getByRole('img', { name: '1 watcher running' })).toHaveTextContent('1')

    act(() => {
      fake.emit({
        type: EventType.WatchersChanged,
        taskId: 't1',
        watchers: [running('ci', { state: WatcherState.Stopped, outcome: 'Stopped.' })],
      })
    })
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('renders again only when its own count changes, not on any other change to the watchers', async () => {
    const { fake } = await renderBadge([running('ci')])
    vi.mocked(watchingLabel).mockClear()

    // A live watcher reports something; the live count doesn't: no extra render.
    act(() => {
      fake.emit({ type: EventType.WatchersChanged, taskId: 't1', watchers: [running('ci', { lastOutput: 'tick' })] })
    })
    expect(renders()).toBe(0)
    expect(screen.getByRole('img', { name: '1 watcher running' })).toHaveTextContent('1')

    // A second watcher starts: the count changes, one render.
    act(() => {
      fake.emit({ type: EventType.WatchersChanged, taskId: 't1', watchers: [running('ci'), running('rollout')] })
    })
    expect(renders()).toBe(1)
    expect(screen.getByRole('img', { name: '2 watchers running' })).toHaveTextContent('2')
  })

  it('is its own badge per task: another task’s watchers don’t show on it', async () => {
    await renderBadge([sampleWatcher('w2', 't2', { label: 'Other task CI' })])

    expect(screen.queryByRole('img')).toBeNull()
  })
})
