import { describe, expect, it, vi } from 'vitest'
import { EVENT_BATCH, EVENT_CHANNEL, EventType, type GladeEvent, type WindowEvent } from '../shared/bridge'
import { UiStateKey } from '../shared/domain'
import { createBridge, type IpcListener, type RendererIpc } from './bridge'

/** An `ipcRenderer` that main's events can be sent on. */
function fakeIpc(): { readonly ipc: RendererIpc; readonly send: (event: WindowEvent) => void } {
  const listeners = new Set<IpcListener>()
  return {
    ipc: {
      invoke: () => Promise.resolve({ ok: true, value: null }),
      on: (_channel, listener) => listeners.add(listener),
      removeListener: (_channel, listener) => listeners.delete(listener),
    },
    send: (event) => {
      for (const listener of listeners) listener({ sender: 'main' }, event)
    },
  }
}

const entry = (value: string): GladeEvent => ({
  type: EventType.UiStateChanged,
  entry: { key: UiStateKey.ActiveWorkspaceId, value },
})

describe('a batch of events (#489)', () => {
  it('goes to the batch listener whole, and each event on its own to the listener', () => {
    const { ipc, send } = fakeIpc()
    const listener = vi.fn()
    const batchListener = vi.fn()
    createBridge(ipc).subscribe(listener, batchListener)

    send(entry('a'))
    send({ type: EVENT_BATCH, events: [entry('b'), entry('c')] })

    expect(listener.mock.calls).toEqual([[entry('a')]])
    expect(batchListener.mock.calls).toEqual([[[entry('b'), entry('c')]]])
  })

  it('goes to a subscriber with no batch listener event by event, in order', () => {
    const { ipc, send } = fakeIpc()
    const listener = vi.fn()
    createBridge(ipc).subscribe(listener)

    send({ type: EVENT_BATCH, events: [entry('a'), entry('b')] })
    send(entry('c'))

    expect(listener.mock.calls).toEqual([[entry('a')], [entry('b')], [entry('c')]])
  })

  it('stops with the subscription', () => {
    const { ipc, send } = fakeIpc()
    const listener = vi.fn()
    const batchListener = vi.fn()
    const unsubscribe = createBridge(ipc).subscribe(listener, batchListener)

    unsubscribe()
    send({ type: EVENT_BATCH, events: [entry('a')] })

    expect(listener).not.toHaveBeenCalled()
    expect(batchListener).not.toHaveBeenCalled()
  })

  it('arrives on the event channel', () => {
    const on = vi.fn()
    createBridge({ invoke: vi.fn(), on, removeListener: vi.fn() }).subscribe(vi.fn(), vi.fn())

    expect(on).toHaveBeenCalledWith(EVENT_CHANNEL, expect.any(Function))
  })
})
