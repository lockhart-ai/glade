import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import { TaskActivity, TaskState, UiStateKey, type Task } from '../../shared/domain'
import { ToastProvider } from '../components'
import { settleFloating } from '../components/settleFloating'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore } from '../store/store'
import { fakeBridge, refuse, sampleTask, sampleWorkspace, type FakeHandlers } from '../store/test-bridge'
import { canCompact } from './compact'
import { ContextDetails, ContextMeter, ContextMeterView } from './ContextMeter'

const TASK: Task = {
  ...sampleTask('t1', 'w1'),
  sessionId: 'session-1',
  contextUsedTokens: 76_000,
  contextWindowTokens: 200_000,
}

async function renderMeter(task: Task | null = TASK, overrides: Partial<FakeHandlers> = {}) {
  const fake = fakeBridge(
    {
      workspaces: [sampleWorkspace('w1')],
      tasks: [task ?? TASK],
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: task === null ? '' : task.id },
      ],
    },
    overrides,
  )
  const store = createGladeStore(fake.bridge)
  render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <ContextMeter />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  await act(() => store.getState().hydrate())
  return fake
}

function arc(): string | null | undefined {
  return screen.getByRole('meter').querySelectorAll('circle')[1]?.getAttribute('stroke-dasharray')
}

function arcClass(): string {
  return screen.getByRole('meter').className
}

async function openPopover(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: 'Context' }))
  await settleFloating()
  return screen.getByRole('dialog', { name: 'Context' })
}

describe('ContextMeter', () => {
  it("shows the selected task's context usage as a ring and a reading", async () => {
    await renderMeter()

    const meter = screen.getByRole('meter', { name: 'Context used' })
    expect(meter).toHaveTextContent('38% · 76k / 200k')
    expect(meter).toHaveAttribute('aria-valuenow', '38')
    expect(meter).toHaveAttribute('aria-valuetext', '38% · 76k / 200k')
    expect(meter).toHaveAttribute('title', 'Context used')
    // The design's ring: 38% of a 37.7-long circle.
    expect(arc()).toBe('14.3 37.7')
  })

  it('follows the task as the agent uses more context', async () => {
    const fake = await renderMeter()

    act(() => {
      fake.emit({ type: EventType.TaskUpdated, task: { ...TASK, contextUsedTokens: 122_000 } })
    })

    expect(screen.getByRole('meter')).toHaveTextContent('61% · 122k / 200k')
  })

  it('shows nothing without a selected task', async () => {
    await renderMeter(null)
    expect(screen.queryByRole('meter')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('opens the popover on a click: usage, the auto-compact threshold and Compact now', async () => {
    await renderMeter()
    const button = screen.getByRole('button', { name: 'Context' })
    expect(button).toHaveAttribute('aria-haspopup', 'dialog')
    expect(button).toHaveAttribute('aria-expanded', 'false')

    const popover = await openPopover()

    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(within(popover).getByTestId('context-usage')).toHaveTextContent('38% · 76k / 200k')
    expect(popover).toHaveTextContent(
      'Compacts automatically at 84%. Compacting replaces older turns with a summary for the agent; the full chat and tool log stay here.',
    )
    expect(within(popover).getByTestId('auto-compact-marker')).toHaveStyle({ left: '83.5%' })
    expect(within(popover).getByRole('button', { name: 'Compact now' })).toBeEnabled()
    expect(popover).toHaveTextContent('⌘⇧K')

    fireEvent.keyDown(popover, { key: 'Escape' })
    await settleFloating()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('compacts on Compact now, closing the popover', async () => {
    const { invoke } = await renderMeter()
    const popover = await openPopover()

    fireEvent.click(within(popover).getByRole('button', { name: 'Compact now' }))
    await settleFloating()

    expect(invoke).toHaveBeenCalledWith(CommandName.TasksCompact, { id: 't1' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows a toast when main refuses to compact', async () => {
    await renderMeter(TASK, {
      [CommandName.TasksCompact]: () => refuse(bridgeError(BridgeErrorCode.Busy, 'The agent is working')),
    })
    const popover = await openPopover()

    fireEvent.click(within(popover).getByRole('button', { name: 'Compact now' }))

    expect(await screen.findByText('The agent is working')).toBeInTheDocument()
  })

  it('turns Compact now off while the agent works', async () => {
    await renderMeter({ ...TASK, activity: TaskActivity.Working })
    const popover = await openPopover()
    expect(within(popover).getByRole('button', { name: 'Compact now' })).toBeDisabled()
  })
})

describe('ContextMeterView', () => {
  it('reads a new task as empty, with an empty ring', () => {
    render(<ContextMeterView usedTokens={0} windowTokens={1_000_000} />)

    expect(screen.getByRole('meter')).toHaveTextContent('0% · 0k / 1M')
    expect(arc()).toBe('0.0 37.7')
  })

  it('turns the ring purple near the auto-compact threshold, as the design shows at 97%', () => {
    const { rerender } = render(<ContextMeterView usedTokens={146_000} windowTokens={200_000} />)
    expect(arcClass()).not.toMatch(/near/)

    rerender(<ContextMeterView usedTokens={194_000} windowTokens={200_000} />)
    expect(arcClass()).toMatch(/near/)
    expect(arc()).toBe('36.6 37.7')
  })
})

describe('ContextDetails', () => {
  it('fills the bar as far as the context is used, purple near the threshold', () => {
    const onCompact = vi.fn()
    render(<ContextDetails usedTokens={194_000} windowTokens={200_000} compactable onCompact={onCompact} />)

    expect(screen.getByTestId('context-usage')).toHaveTextContent('97% · 194k / 200k')
    expect(screen.getByTestId('context-usage').parentElement?.parentElement?.className).toMatch(/near/)
    fireEvent.click(screen.getByRole('button', { name: 'Compact now' }))
    expect(onCompact).toHaveBeenCalledOnce()
  })
})

describe('canCompact', () => {
  it('is true for an active, idle task with a session', () => {
    expect(canCompact(TASK)).toBe(true)
    expect(canCompact({ ...TASK, activity: TaskActivity.Error })).toBe(true)
  })

  it('is false while the agent works, for a done task, and before the agent has a session', () => {
    expect(canCompact({ ...TASK, activity: TaskActivity.Working })).toBe(false)
    expect(canCompact({ ...TASK, state: TaskState.Done })).toBe(false)
    expect(canCompact({ ...TASK, sessionId: null })).toBe(false)
  })
})
