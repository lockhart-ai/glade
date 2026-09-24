import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CommandName } from '../../shared/bridge'
import { UiStateKey, type UiStateEntry } from '../../shared/domain'
import { serializeRelaunchNotice } from '../../shared/relaunchNotice'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import { fakeBridge, sampleTask, sampleWorkspace, type FakeBridge } from '../store/test-bridge'
import { RelaunchNotice, relaunchMessage } from './RelaunchNotice'

interface Rendered {
  readonly fake: FakeBridge
  readonly store: GladeStore
}

/** Renders the notice over two workspaces' tasks, with `notice` as its UI state value (none when undefined). */
async function renderNotice(notice: string | undefined, selectedTaskId = ''): Promise<Rendered> {
  const uiState: UiStateEntry[] = [
    { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
    { key: UiStateKey.SelectedTaskId, value: selectedTaskId },
    ...(notice === undefined ? [] : [{ key: UiStateKey.RelaunchNotice, value: notice }]),
  ]
  const fake = fakeBridge({
    workspaces: [sampleWorkspace('w1'), sampleWorkspace('w2', 'Acme web')],
    tasks: [sampleTask('t1', 'w2', 'Fix flaky login test'), sampleTask('t2', 'w1', 'Move image uploads to S3')],
    uiState,
  })
  const store = createGladeStore(fake.bridge)
  render(
    <GladeStoreProvider store={store}>
      <RelaunchNotice />
    </GladeStoreProvider>,
  )
  await act(() => store.getState().hydrate())
  return { fake, store }
}

function notice(): HTMLElement {
  return screen.getByRole('status', { name: 'Glade quit unexpectedly' })
}

describe('relaunchMessage', () => {
  it('says how many tasks picked up where they left off', () => {
    expect(relaunchMessage(1)).toBe('Everything was saved. 1 task was mid-turn and has picked up where it left off.')
    expect(relaunchMessage(2)).toBe(
      'Everything was saved. 2 tasks were mid-turn and have picked up where they left off.',
    )
  })
})

describe('RelaunchNotice', () => {
  it('shows nothing without a notice', async () => {
    await renderNotice(undefined)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it.each([
    ['dismissed', ''],
    ['its tasks are all gone', serializeRelaunchNotice({ taskIds: ['gone'] })],
  ])('shows nothing when %s', async (_, value) => {
    await renderNotice(value)

    expect(screen.queryByRole('status')).toBeNull()
  })

  it('says Glade quit unexpectedly, and how many of the tasks it names are still here', async () => {
    await renderNotice(serializeRelaunchNotice({ taskIds: ['t1', 'gone', 't2'] }))

    expect(notice()).toHaveTextContent('Glade quit unexpectedly')
    expect(notice()).toHaveTextContent(relaunchMessage(2))
    expect(screen.getByRole('button', { name: 'Show them' })).toBeInTheDocument()
  })

  it('goes away for good when dismissed', async () => {
    const { fake } = await renderNotice(serializeRelaunchNotice({ taskIds: ['t1'] }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
      await Promise.resolve()
    })

    expect(screen.queryByRole('status')).toBeNull()
    expect(fake.invoke).toHaveBeenCalledWith(CommandName.UiStateSet, { key: UiStateKey.RelaunchNotice, value: '' })
  })

  it('shows them by opening the first in the workspace you are looking at, and goes away', async () => {
    const { store } = await renderNotice(serializeRelaunchNotice({ taskIds: ['t1', 't2'] }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show them' }))
      await Promise.resolve()
    })

    expect(store.getState()).toMatchObject({ selectedWorkspaceId: 'w1', selectedTaskId: 't2' })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows them by opening the first, in its own workspace, when none is in the one you are looking at', async () => {
    const { store } = await renderNotice(serializeRelaunchNotice({ taskIds: ['t1'] }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show them' }))
      await Promise.resolve()
    })

    expect(store.getState()).toMatchObject({ selectedWorkspaceId: 'w2', selectedTaskId: 't1' })
  })
})
