import { act, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { EventType } from '../../shared/bridge'
import { UiStateKey, type Task } from '../../shared/domain'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore } from '../store/store'
import { fakeBridge, sampleTask, sampleWorkspace, type FakeBridge } from '../store/test-bridge'
import { ContextMeter, ContextMeterView } from './ContextMeter'

const TASK: Task = { ...sampleTask('t1', 'w1'), contextUsedTokens: 76_000, contextWindowTokens: 200_000 }

async function renderMeter(selected = true): Promise<FakeBridge> {
  const fake = fakeBridge({
    workspaces: [sampleWorkspace('w1')],
    tasks: [TASK],
    uiState: [
      { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
      { key: UiStateKey.SelectedTaskId, value: selected ? 't1' : '' },
    ],
  })
  const store = createGladeStore(fake.bridge)
  render(
    <GladeStoreProvider store={store}>
      <ContextMeter />
    </GladeStoreProvider>,
  )
  await act(() => store.getState().hydrate())
  return fake
}

function arc(): string | null | undefined {
  return screen.getByRole('meter').querySelectorAll('circle')[1]?.getAttribute('stroke-dasharray')
}

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
  await renderMeter(false)
  expect(screen.queryByRole('meter')).toBeNull()
})

it('reads a new task as empty, with an empty ring', () => {
  render(<ContextMeterView usedTokens={0} windowTokens={1_000_000} />)

  expect(screen.getByRole('meter')).toHaveTextContent('0% · 0k / 1M')
  expect(arc()).toBe('0.0 37.7')
})
