import { afterEach, expect, it, vi } from 'vitest'
import { PLUGIN_MESSAGE_CHANNEL } from '../shared/plugin-api'

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn<(key: string, api: object) => void>(),
  ipcRenderer: { send: vi.fn(), on: vi.fn() },
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: electron.ipcRenderer,
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

it('exposes the bridge to the page as window.glade, with post and nothing else', async () => {
  vi.stubGlobal('window', { postMessage: vi.fn() })

  await import('./plugin')

  expect(electron.exposeInMainWorld).toHaveBeenCalledOnce()
  const [key, api] = electron.exposeInMainWorld.mock.calls[0] ?? []
  expect(key).toBe('glade')
  expect(api).toEqual({ post: expect.any(Function) as unknown })
  expect(electron.ipcRenderer.on).toHaveBeenCalledWith(PLUGIN_MESSAGE_CHANNEL, expect.any(Function))
})
