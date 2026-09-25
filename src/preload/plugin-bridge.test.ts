import { describe, expect, it, vi } from 'vitest'
import { MAX_PLUGIN_MESSAGE_BYTES, PLUGIN_MESSAGE_CHANNEL, PLUGIN_POST_CHANNEL } from '../shared/plugin-api'
import { createPluginBridge, type PluginIpc } from './plugin-bridge'

type Listener = (event: unknown, message: unknown) => void

function fakeIpc(): PluginIpc & { readonly listeners: Map<string, Listener>; readonly sent: unknown[][] } {
  const listeners = new Map<string, Listener>()
  const sent: unknown[][] = []
  return {
    listeners,
    sent,
    send: (channel, message) => sent.push([channel, message]),
    on: (channel, listener) => listeners.set(channel, listener),
  }
}

describe('createPluginBridge', () => {
  it("posts main's messages to the page", () => {
    const ipc = fakeIpc()
    const page = { postMessage: vi.fn() }
    createPluginBridge(ipc, page)

    ipc.listeners.get(PLUGIN_MESSAGE_CHANNEL)?.({}, { source: 'glade', seq: 1 })

    expect(page.postMessage).toHaveBeenCalledWith({ source: 'glade', seq: 1 }, '*')
  })

  it("sends the page's messages to main", () => {
    const ipc = fakeIpc()
    const bridge = createPluginBridge(ipc, { postMessage: vi.fn() })

    bridge.post({ type: 'ready' })

    expect(ipc.sent).toEqual([[PLUGIN_POST_CHANNEL, { type: 'ready' }]])
  })

  it('exposes post and nothing else', () => {
    expect(Object.keys(createPluginBridge(fakeIpc(), { postMessage: vi.fn() }))).toEqual(['post'])
  })

  it('drops a message too big to send', () => {
    const ipc = fakeIpc()
    const bridge = createPluginBridge(ipc, { postMessage: vi.fn() })

    bridge.post({ type: 'status', text: 'x'.repeat(MAX_PLUGIN_MESSAGE_BYTES) })
    bridge.post({ type: 'status', text: 'x'.repeat(10_000_000) })

    expect(ipc.sent).toEqual([])
  })

  it('sends a message right at the limit', () => {
    const ipc = fakeIpc()
    const bridge = createPluginBridge(ipc, { postMessage: vi.fn() })
    const wrapper = JSON.stringify({ text: '' }).length

    bridge.post({ text: 'x'.repeat(MAX_PLUGIN_MESSAGE_BYTES - wrapper) })

    expect(ipc.sent).toHaveLength(1)
  })

  it("drops what can't be written as JSON", () => {
    const ipc = fakeIpc()
    const bridge = createPluginBridge(ipc, { postMessage: vi.fn() })
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle

    bridge.post(cycle)
    bridge.post(10n)
    bridge.post(undefined)
    bridge.post(() => 'ready')

    expect(ipc.sent).toEqual([])
  })
})
