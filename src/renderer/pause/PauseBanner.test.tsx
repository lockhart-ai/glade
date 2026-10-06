import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SAMPLE_CHOICE } from '../../shared/test-openrouter'
import { AgentSource } from '../../shared/openrouter'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import { PauseReason, TaskActivity, UiStateKey, type Task, type TaskPause } from '../../shared/domain'
import type { ModelChoice } from '../../shared/models'
import { SDK_MODELS } from '../../shared/test-models'
import { ToastProvider } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore } from '../store/store'
import { fakeBridge, sampleTask, sampleWorkspace } from '../store/test-bridge'
import { PauseBanner } from './PauseBanner'

const RESUMES_AT = new Date(2099, 8, 23, 11, 42).getTime()

/** A usage limit's pause that resumes at `resumesAt`. */
function pauseUntil(resumesAt: number): TaskPause {
  return { reason: PauseReason.UsageLimit, since: 2_000, resumesAt, checks: 0, details: 'Still over the limit.' }
}

function paused(
  id: string,
  workspaceId: string,
  reason: PauseReason,
  title: string,
  model = 'claude-opus-5-5[1m]',
): Task {
  return {
    ...sampleTask(id, workspaceId, title),
    model,
    activity: TaskActivity.Paused,
    pause: { reason, since: 1_000, resumesAt: RESUMES_AT, checks: 0, details: `${title}: what the API said` },
  }
}

async function renderBanner(tasks: Task[], models?: readonly ModelChoice[], retry?: () => Promise<{ task: Task }>) {
  const fake = fakeBridge(
    {
      workspaces: [sampleWorkspace('w1'), sampleWorkspace('w2', 'Billing')],
      tasks,
      uiState: [{ key: UiStateKey.ActiveWorkspaceId, value: 'w1' }],
      ...(models === undefined ? {} : { models }),
    },
    retry === undefined ? {} : { [CommandName.TasksRetry]: retry },
  )
  const store = createGladeStore(fake.bridge)
  render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <PauseBanner />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  await act(() => store.getState().hydrate())
  return fake
}

function banner(): HTMLElement {
  return screen.getByRole('status', { name: 'Paused tasks' })
}

const LIMITED = [
  paused('t1', 'w1', PauseReason.UsageLimit, 'Add rate limiting to public API'),
  paused('t2', 'w1', PauseReason.UsageLimit, 'Move image uploads to S3'),
  // Another workspace's: the banner is app-wide.
  paused('t3', 'w2', PauseReason.UsageLimit, 'Fix flaky login test'),
]

describe('PauseBanner', () => {
  it('shows nothing while no task is paused, and appears when one pauses', async () => {
    const { emit } = await renderBanner([sampleTask('t1', 'w1')])
    expect(screen.queryByRole('status')).toBeNull()

    act(() => {
      emit({ type: EventType.TaskUpdated, task: paused('t1', 'w1', PauseReason.Offline, 'Move image uploads to S3') })
    })
    expect(banner()).toHaveTextContent(
      'Can’t reach the API. 1 task is paused and will resume on its own when the network is back.',
    )
    // Switching model doesn't bring the network back.
    expect(within(banner()).queryByRole('button', { name: 'Switch model' })).toBeNull()
  })

  it('counts every workspace’s paused tasks and says when they resume', async () => {
    await renderBanner([...LIMITED, sampleTask('t4', 'w1')])

    expect(within(banner()).getByText('Usage limit reached.').tagName).toBe('STRONG')
    expect(banner()).toHaveTextContent(
      'Usage limit reached. 3 tasks are paused and will resume on their own at Sep 23 11:42.',
    )
  })

  it('lists the paused tasks and what the API said in its details', async () => {
    await renderBanner(LIMITED.slice(0, 2))
    const details = within(banner()).getByRole('button', { name: 'Details' })
    expect(details).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(details)
    const list = within(banner()).getByRole('list', { name: 'Paused tasks' })
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Add rate limiting to public APIPaused: usage limit · resumes Sep 23 11:42',
      'Move image uploads to S3Paused: usage limit · resumes Sep 23 11:42',
    ])
    expect(within(banner()).getByLabelText('What the API said')).toHaveTextContent(
      'Add rate limiting to public API: what the API said Move image uploads to S3: what the API said',
    )

    fireEvent.click(within(banner()).getByRole('button', { name: 'Hide details' }))
    expect(within(banner()).queryByRole('list')).toBeNull()
  })

  it('offers Resume now beside Switch model, as a secondary button like it, ahead of Details', async () => {
    await renderBanner(LIMITED)

    const buttons = within(banner()).getAllByRole('button')
    expect(buttons.map((button) => button.textContent)).toEqual(['Resume now', 'Switch model', 'Details'])
    const [resume, switchModel] = buttons
    expect(resume?.className).toBe(switchModel?.className)
  })

  it('resumes every task a usage limit paused with one command, whatever their workspace, and they go', async () => {
    const offline = paused('t9', 'w1', PauseReason.Offline, 'Upgrade Django')
    const { invoke } = await renderBanner([...LIMITED, offline])
    invoke.mockClear()

    fireEvent.click(within(banner()).getByRole('button', { name: 'Resume now' }))

    // One command to main for all three, and none per task.
    expect(invoke.mock.calls).toEqual([[CommandName.TasksResumePaused, {}]])
    // The fake main resumes them: only the task waiting for the network is left, with nothing to press.
    expect(await within(banner()).findByText('Can’t reach the API.')).toBeInTheDocument()
    expect(banner()).toHaveTextContent('1 task is paused and will resume on its own when the network is back.')
    expect(within(banner()).queryByRole('button', { name: 'Resume now' })).toBeNull()
  })

  it('keeps the banner, and its Resume now, for a task that pauses again: no error, and it can be pressed again', async () => {
    const [first] = LIMITED
    const { invoke, emit } = await renderBanner(LIMITED.slice(0, 1))

    fireEvent.click(within(banner()).getByRole('button', { name: 'Resume now' }))
    await act(() => Promise.resolve())
    expect(screen.queryByRole('status')).toBeNull()

    // Still over the limit: main pauses it again, with the reset time it was given.
    const later = new Date(2099, 8, 23, 12, 5).getTime()
    act(() => {
      emit({
        type: EventType.TaskUpdated,
        task: { ...paused('t1', 'w1', PauseReason.UsageLimit, first?.title ?? ''), pause: pauseUntil(later) },
      })
    })

    expect(banner()).toHaveTextContent(
      'Usage limit reached. 1 task is paused and will resume on its own at Sep 23 12:05.',
    )
    expect(screen.queryByRole('alert')).toBeNull()
    invoke.mockClear()
    fireEvent.click(within(banner()).getByRole('button', { name: 'Resume now' }))
    expect(invoke).toHaveBeenCalledExactlyOnceWith(CommandName.TasksResumePaused, {})
  })

  it('says so when the tasks could not be resumed, and stays', async () => {
    const { invoke } = await renderBanner(LIMITED)
    invoke.mockRejectedValueOnce(bridgeError(BridgeErrorCode.Internal, 'tasks.resumePaused failed: disk full'))

    fireEvent.click(within(banner()).getByRole('button', { name: 'Resume now' }))

    expect(
      await screen.findByText('Couldn’t resume the paused tasks: tasks.resumePaused failed: disk full'),
    ).toBeInTheDocument()
    expect(banner()).toHaveTextContent('3 tasks are paused')
  })

  it('moves the tasks a usage limit paused to the model you pick, and resumes them now', async () => {
    const offline = paused('t9', 'w1', PauseReason.Offline, 'Upgrade Django')
    const { invoke } = await renderBanner([...LIMITED, offline])

    const button = within(banner()).getByRole('button', { name: 'Switch model' })
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    // They all run on Opus now.
    expect(await screen.findByRole('menuitemradio', { name: 'Opus 5.5' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Sonnet 5' }))
    await act(() => Promise.resolve())

    for (const id of ['t1', 't2', 't3']) {
      expect(invoke).toHaveBeenCalledWith(CommandName.TasksRetry, { id, model: 'claude-sonnet-5' })
    }
    expect(invoke).not.toHaveBeenCalledWith(CommandName.TasksRetry, expect.objectContaining({ id: 't9' }))
  })

  it('groups the sources and switches paused tasks one at a time with pending feedback', async () => {
    const model: ModelChoice = {
      id: SAMPLE_CHOICE.id,
      name: 'Sample Flash · Sample Host',
      description: '',
      resolvedModel: null,
      efforts: [],
      source: AgentSource.OpenRouter,
    }
    let finish: (value: { task: Task }) => void = () => undefined
    const retry = vi.fn(
      () =>
        new Promise<{ task: Task }>((resolve) => {
          finish = resolve
        }),
    )
    await renderBanner(LIMITED.slice(0, 2), [...SDK_MODELS, model], retry)
    fireEvent.click(screen.getByRole('button', { name: 'Switch model' }))
    expect(await screen.findByText('OpenRouter')).toBeInTheDocument()
    expect(screen.getByText('Anthropic account')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitemradio', { name: model.name }))
    expect(await screen.findByRole('button', { name: 'Switching…' })).toBeDisabled()
    expect(retry).toHaveBeenCalledOnce()
    await act(() => {
      finish({ task: { ...sampleTask('t1', 'w1'), activity: TaskActivity.Working, pause: null } })
      return Promise.resolve()
    })
    expect(retry).toHaveBeenCalledTimes(2)
    await act(() => {
      finish({ task: { ...sampleTask('t2', 'w1'), activity: TaskActivity.Working, pause: null } })
      return Promise.resolve()
    })
  })

  it('offers the SDK’s models, checking the one the tasks run on, whether saved by its alias or its full id', async () => {
    const { invoke } = await renderBanner(
      [
        paused('t1', 'w1', PauseReason.UsageLimit, 'Add rate limiting to public API', 'sonnet'),
        paused('t2', 'w1', PauseReason.UsageLimit, 'Move image uploads to S3', 'claude-sonnet-5'),
      ],
      SDK_MODELS,
    )

    fireEvent.click(within(banner()).getByRole('button', { name: 'Switch model' }))
    const menu = await screen.findByRole('menu')
    expect(
      within(menu)
        .getAllByRole('menuitemradio')
        .filter((item) => item.getAttribute('aria-checked') === 'true')
        .map((item) => item.textContent),
    ).toEqual(['Sonnet'])
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Haiku' }))
    await act(() => Promise.resolve())

    expect(invoke).toHaveBeenCalledWith(CommandName.TasksRetry, { id: 't1', model: 'haiku' })
    expect(invoke).toHaveBeenCalledWith(CommandName.TasksRetry, { id: 't2', model: 'haiku' })
  })

  it('checks no model when the paused tasks run on different ones', async () => {
    await renderBanner([
      paused('t1', 'w1', PauseReason.UsageLimit, 'Add rate limiting to public API'),
      paused('t5', 'w1', PauseReason.UsageLimit, 'Other', 'claude-haiku-4-5'),
    ])

    fireEvent.click(within(banner()).getByRole('button', { name: 'Switch model' }))
    const menu = await screen.findByRole('menu')
    for (const item of within(menu).getAllByRole('menuitemradio')) expect(item).toHaveAttribute('aria-checked', 'false')

    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('says so when a task could not be moved', async () => {
    const { invoke } = await renderBanner(LIMITED.slice(0, 1))
    invoke.mockRejectedValueOnce(bridgeError(BridgeErrorCode.Busy, 'The agent is working'))

    fireEvent.click(within(banner()).getByRole('button', { name: 'Switch model' }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Haiku 4.5' }))

    expect(await screen.findByText('Couldn’t switch the model: The agent is working')).toBeInTheDocument()
  })
})
