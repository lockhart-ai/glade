import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { UsageWindow, type AccountStatus, type UsageWarning } from '../../shared/account'
import { EventType } from '../../shared/bridge'
import { PauseReason, TaskActivity, UiStateKey, type Task } from '../../shared/domain'
import { ToastProvider } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore } from '../store/store'
import { fakeBridge, sampleTask, sampleWorkspace } from '../store/test-bridge'
import { AppBanner } from './UsageNote'

const RESETS_AT = new Date(2099, 8, 23, 11, 42).getTime()

const WARNING: UsageWarning = { utilization: 0.85, window: UsageWindow.Session, resetsAt: RESETS_AT }

function warned(usageWarning: UsageWarning | null): AccountStatus {
  return { account: null, usageWarning }
}

function pausedTask(id: string, reason = PauseReason.UsageLimit): Task {
  return {
    ...sampleTask(id, 'w1', 'Move image uploads to S3'),
    activity: TaskActivity.Paused,
    pause: { reason, since: 1_000, resumesAt: RESETS_AT, checks: 0, details: 'You’ve hit your session limit' },
  }
}

async function renderBanner(tasks: Task[], accountStatus: AccountStatus) {
  const fake = fakeBridge({
    workspaces: [sampleWorkspace('w1')],
    tasks,
    uiState: [{ key: UiStateKey.ActiveWorkspaceId, value: 'w1' }],
    accountStatus,
  })
  const store = createGladeStore(fake.bridge)
  render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <AppBanner />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  await act(() => store.getState().hydrate())
  return fake
}

function note(): HTMLElement | null {
  return screen.queryByRole('status', { name: 'Usage warning' })
}

function pauseBanner(): HTMLElement | null {
  return screen.queryByRole('status', { name: 'Paused tasks' })
}

describe('AppBanner', () => {
  it('shows nothing while no limit is close and no task is paused', async () => {
    await renderBanner([sampleTask('t1', 'w1')], warned(null))

    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows the quiet note while a limit is close: how much is used, and when it resets', async () => {
    await renderBanner([sampleTask('t1', 'w1')], warned(WARNING))

    expect(note()).toHaveTextContent('You’ve used 85% of your session limit · resets Sep 23 11:42')
    // It asks nothing of you: tasks keep working.
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('comes, changes and goes as main says', async () => {
    const { emit } = await renderBanner([sampleTask('t1', 'w1')], warned(null))

    act(() => {
      emit({ type: EventType.AccountChanged, status: warned(WARNING) })
    })
    expect(note()).toHaveTextContent('85%')
    act(() => {
      emit({ type: EventType.AccountChanged, status: warned({ ...WARNING, utilization: 0.97 }) })
    })
    expect(note()).toHaveTextContent('You’ve used 97% of your session limit')
    // The window reset.
    act(() => {
      emit({ type: EventType.AccountChanged, status: warned(null) })
    })
    expect(note()).toBeNull()
  })

  it('gives way to the paused tasks’ banner once a task pauses, never showing both, and comes back after', async () => {
    const { emit } = await renderBanner([sampleTask('t1', 'w1')], warned(WARNING))
    expect(note()).not.toBeNull()

    act(() => {
      emit({ type: EventType.TaskUpdated, task: pausedTask('t1') })
    })
    expect(pauseBanner()).toHaveTextContent('Usage limit reached.')
    expect(note()).toBeNull()
    expect(screen.getAllByRole('status')).toHaveLength(1)

    // Resumed, with the warning still standing: the note is back.
    act(() => {
      emit({ type: EventType.TaskUpdated, task: sampleTask('t1', 'w1') })
    })
    expect(pauseBanner()).toBeNull()
    expect(note()).not.toBeNull()
  })

  it('gives way to the banner for tasks paused offline too: there is one banner at a time', async () => {
    await renderBanner([pausedTask('t1', PauseReason.Offline)], warned(WARNING))

    expect(pauseBanner()).toHaveTextContent('Can’t reach the API.')
    expect(note()).toBeNull()
  })
})
