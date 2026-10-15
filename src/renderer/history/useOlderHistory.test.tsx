// The hooks that load a task's older history as you scroll up (#637): the scroll asks for the next older page when
// the scroller comes near its top, and keeps its place while the page goes in above it.
import { act, fireEvent, render } from '@testing-library/react'
import { useRef, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { CommandName } from '../../shared/bridge'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import { bridgeError, BridgeErrorCode } from '../../shared/bridge'
import { fakeBridge, refuse, sampleTask, sampleWorkspace, type FakeHandlers } from '../store/test-bridge'
import { useKeepScrollOnPrepend, useLoadOlderOnScroll } from './useOlderHistory'

function storeWith(handlers: Partial<FakeHandlers> = {}): GladeStore {
  const fake = fakeBridge(
    {
      workspaces: [sampleWorkspace('w1')],
      tasks: [sampleTask('t1', 'w1')],
      uiState: [],
    },
    handlers,
  )
  const store = createGladeStore(fake.bridge)
  store.setState({
    historyTails: {
      t1: { hasOlderMessages: true, hasOlderEvents: false, messagesBefore: null, eventsBefore: null, loading: false },
    },
  })
  return store
}

interface ProbeProps {
  readonly taskId: string
  readonly active: boolean
  readonly firstId: string | null
  readonly content: number
}

function Probe({ taskId, active, firstId, content }: ProbeProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const loadOlderOnScroll = useLoadOlderOnScroll(ref, taskId, active)
  useKeepScrollOnPrepend(ref, firstId, taskId, active, content)
  return (
    <div
      ref={ref}
      data-testid="probe"
      onScroll={() => {
        loadOlderOnScroll()
      }}
    />
  )
}

describe('useLoadOlderOnScroll', () => {
  it('asks for the next older page when the scroller is near its top, and only then', async () => {
    const before = vi.fn(() => ({
      messages: [],
      messagesBefore: null,
      hasOlderMessages: false,
      toolEvents: [],
      eventsBefore: null,
      hasOlderEvents: false,
    }))
    const store = storeWith({ [CommandName.TasksHistoryBefore]: before })
    const { getByTestId, rerender } = render(
      <GladeStoreProvider store={store}>
        <Probe taskId="t1" active firstId="a" content={1} />
      </GladeStoreProvider>,
    )
    const probe = getByTestId('probe')

    // Near the top (scrollTop 0): the store asks main for the page, and the answer ends the older history.
    await act(async () => {
      fireEvent.scroll(probe)
      await Promise.resolve()
    })
    expect(before).toHaveBeenCalledOnce()
    expect(store.getState().historyTails.t1).toEqual({
      hasOlderMessages: false,
      hasOlderEvents: false,
      messagesBefore: null,
      eventsBefore: null,
      loading: false,
    })

    // Far from the top, or a scroller that isn't the task's own log, asks for nothing.
    Object.defineProperty(probe, 'scrollTop', { value: 500, configurable: true })
    fireEvent.scroll(probe)
    expect(before).toHaveBeenCalledOnce()

    rerender(
      <GladeStoreProvider store={store}>
        <Probe taskId="t1" active={false} firstId="a" content={1} />
      </GladeStoreProvider>,
    )
    Object.defineProperty(probe, 'scrollTop', { value: 0, configurable: true })
    fireEvent.scroll(probe)
    expect(before).toHaveBeenCalledOnce()
  })

  it('asks for nothing when the task has no older history to load', () => {
    const before = vi.fn(() => ({
      messages: [],
      messagesBefore: null,
      hasOlderMessages: false,
      toolEvents: [],
      eventsBefore: null,
      hasOlderEvents: false,
    }))
    const store = storeWith({ [CommandName.TasksHistoryBefore]: before })
    store.setState({ historyTails: {} })
    const { getByTestId } = render(
      <GladeStoreProvider store={store}>
        <Probe taskId="t1" active firstId="a" content={1} />
      </GladeStoreProvider>,
    )

    fireEvent.scroll(getByTestId('probe'))

    expect(before).not.toHaveBeenCalled()
  })

  it('carries on when the page fails to load, leaving it to the next scroll', async () => {
    const failing = vi.fn(() => refuse(bridgeError(BridgeErrorCode.Internal, 'tasks.historyBefore failed: busy')))
    const store = storeWith({ [CommandName.TasksHistoryBefore]: failing })
    const { getByTestId } = render(
      <GladeStoreProvider store={store}>
        <Probe taskId="t1" active firstId="a" content={1} />
      </GladeStoreProvider>,
    )

    await act(async () => {
      fireEvent.scroll(getByTestId('probe'))
      await Promise.resolve()
    })

    expect(failing).toHaveBeenCalledOnce()
    // The tail went back to not loading, so the next scroll asks again.
    expect(store.getState().historyTails.t1).toEqual({
      hasOlderMessages: true,
      hasOlderEvents: false,
      messagesBefore: null,
      eventsBefore: null,
      loading: false,
    })
  })
})

describe('useKeepScrollOnPrepend', () => {
  it('moves the scroll down by what a page of older history added above, once per prepend', () => {
    const store = storeWith()
    let height = 100
    const { getByTestId, rerender } = render(
      <GladeStoreProvider store={store}>
        <Probe taskId="t1" active firstId="a" content={1} />
      </GladeStoreProvider>,
    )
    const probe = getByTestId('probe')
    Object.defineProperty(probe, 'scrollHeight', { get: () => height, configurable: true })
    probe.scrollTop = 20
    // The height the hook remembers is the one before the change that prepends: this re-render records it.
    rerender(
      <GladeStoreProvider store={store}>
        <Probe taskId="t1" active firstId="a" content={2} />
      </GladeStoreProvider>,
    )

    // A page goes in above: the first row changes and the content grows by 200, so the scroll follows it.
    height = 300
    rerender(
      <GladeStoreProvider store={store}>
        <Probe taskId="t1" active firstId="b" content={3} />
      </GladeStoreProvider>,
    )
    expect(probe.scrollTop).toBe(220)

    // A live event's row, added at the bottom, leaves the place alone.
    rerender(
      <GladeStoreProvider store={store}>
        <Probe taskId="t1" active firstId="b" content={4} />
      </GladeStoreProvider>,
    )
    height = 350
    rerender(
      <GladeStoreProvider store={store}>
        <Probe taskId="t1" active firstId="b" content={5} />
      </GladeStoreProvider>,
    )
    expect(probe.scrollTop).toBe(220)
  })

  it('does nothing for another task taking over the scroller, or an empty scroller', () => {
    const store = storeWith()
    let height = 100
    const { getByTestId, rerender } = render(
      <GladeStoreProvider store={store}>
        <Probe taskId="t1" active firstId="a" content={1} />
      </GladeStoreProvider>,
    )
    const probe = getByTestId('probe')
    Object.defineProperty(probe, 'scrollHeight', { get: () => height, configurable: true })
    probe.scrollTop = 20

    // Another task's scroller starting fresh: no page went in above this one's rows.
    height = 300
    rerender(
      <GladeStoreProvider store={store}>
        <Probe taskId="t2" active firstId="b" content={2} />
      </GladeStoreProvider>,
    )
    expect(probe.scrollTop).toBe(20)
  })
})

describe('the scroller going away', () => {
  it('leaves the hooks quiet when nothing is mounted', () => {
    const before = vi.fn(() => ({
      messages: [],
      messagesBefore: null,
      hasOlderMessages: false,
      toolEvents: [],
      eventsBefore: null,
      hasOlderEvents: false,
    }))
    const store = storeWith({ [CommandName.TasksHistoryBefore]: before })
    const { unmount } = render(
      <GladeStoreProvider store={store}>
        <Probe taskId="t1" active firstId="a" content={1} />
      </GladeStoreProvider>,
    )

    act(() => {
      unmount()
    })

    expect(before).not.toHaveBeenCalled()
  })
})
