import { expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn<(key: string, api: object) => void>(),
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: electron.ipcRenderer,
}))

it('exposes the bridge to the renderer as window.glade', async () => {
  await import('./index')

  expect(electron.exposeInMainWorld).toHaveBeenCalledOnce()
  const [key, api] = electron.exposeInMainWorld.mock.calls[0] ?? []
  expect(key).toBe('glade')
  expect(api).toEqual({ invoke: expect.any(Function) as unknown, subscribe: expect.any(Function) as unknown })
})
