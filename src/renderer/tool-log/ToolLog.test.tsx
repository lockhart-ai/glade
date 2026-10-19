// The tool log's own rows besides its tool calls and dividers (toolLogModel.test.ts covers those, and
// ToolCallMenu.test.tsx the context menu): the row a GitHub notice gets, at the time it arrived (#682, #715), laid
// out like a tool call's (#748).
import { act, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MessageSource, UiStateKey, type Message } from '../../shared/domain'
import { sampleMessage } from '../store/test-bridge'
import { storeWrapper } from '../store/test-wrapper'
import { ToolLog } from './ToolLog'

async function renderLog(notices: readonly Message[]) {
  const wrapper = storeWrapper({
    uiState: [
      { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
      { key: UiStateKey.SelectedTaskId, value: 't1' },
    ],
  })
  await act(() => wrapper.store.getState().hydrate())
  render(<ToolLog taskId="t1" events={[]} notices={notices} />, { wrapper: wrapper.wrapper })
  return wrapper
}

function notice(id: string, body: string, createdAt = 2_000): Message {
  return { ...sampleMessage(id, 't1', body), createdAt, source: MessageSource.Github }
}

/** A time in this machine's zone, so what the row shows of it is known: "09:30". */
const NINE_THIRTY = new Date(2026, 0, 2, 9, 30).getTime()

describe('a GitHub notice’s rows (#682, #715, #748)', () => {
  it('renders each link as a tool call’s row is laid out', async () => {
    await renderLog([
      notice(
        'g1',
        [
          'GitHub:',
          '- PR #2537 Port the chat cases: CI failed (13/14); 2 new comments',
          '- Issue #7 Flaky login test: reopened',
        ].join('\n'),
        NINE_THIRTY,
      ),
    ])

    const [first, second] = screen.getAllByRole('group', { name: 'GitHub' })
    if (first === undefined || second === undefined) throw new Error('expected a row per link')
    expect(within(first).getByText('GitHub')).toBeInTheDocument()
    expect(within(first).getByText('PR #2537 Port the chat cases')).toBeInTheDocument()
    expect(within(first).getByText('CI failed (13/14); 2 new comments')).toBeInTheDocument()
    expect(within(first).getByText('09:30')).toBeInTheDocument()
    expect(within(second).getByText('Issue #7 Flaky login test')).toBeInTheDocument()
    expect(within(second).getByText('reopened')).toBeInTheDocument()
    // The notice, not a tool call: no "No tool calls yet." empty state.
    expect(screen.queryByText('No tool calls yet.')).toBeNull()
  })

  it('shows no change under a link whose line holds none', async () => {
    await renderLog([notice('g1', 'GitHub:\n- PR #12 Port the chat cases', NINE_THIRTY)])
    const row = screen.getByRole('group', { name: 'GitHub' })
    expect(within(row).getByText('PR #12 Port the chat cases')).toBeInTheDocument()
    // No change to show: the row is its line alone, as a call with nothing to show under it is.
    expect(row.children).toHaveLength(1)
  })

  it('shows nothing of it when there’s none', async () => {
    await renderLog([])
    expect(screen.queryByRole('group', { name: 'GitHub' })).toBeNull()
    expect(screen.getByText('No tool calls yet.')).toBeInTheDocument()
  })
})
