// The tool log's own rows besides its tool calls and dividers (toolLogModel.test.ts covers those, and
// ToolCallMenu.test.tsx the context menu): the row a GitHub notice gets, at the time it arrived (#682, #715).
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

describe('a GitHub notice’s row (#682, #715)', () => {
  it('shows the GitHub mark and one line per link that changed', async () => {
    await renderLog([
      notice(
        'g1',
        [
          'GitHub:',
          '- PR #2537 Port the chat cases: CI failed (13/14); 2 new comments',
          '- Issue #7 Flaky login test: reopened',
        ].join('\n'),
      ),
    ])

    const row = screen.getByRole('group', { name: 'GitHub' })
    expect(within(row).getByText('GitHub')).toBeInTheDocument()
    expect(row).toHaveTextContent('PR #2537 Port the chat cases: CI failed (13/14); 2 new comments')
    expect(row).toHaveTextContent('Issue #7 Flaky login test: reopened')
    // The notice, not a tool call: no "No tool calls yet." empty state.
    expect(screen.queryByText('No tool calls yet.')).toBeNull()
  })

  it('shows nothing of it when there’s none', async () => {
    await renderLog([])
    expect(screen.queryByRole('group', { name: 'GitHub' })).toBeNull()
    expect(screen.getByText('No tool calls yet.')).toBeInTheDocument()
  })
})
