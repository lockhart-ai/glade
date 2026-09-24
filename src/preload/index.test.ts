import { expect, it, vi } from 'vitest'

const exposeInMainWorld = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld } }))

it('exposes the bridge to the renderer as window.glade', async () => {
  await import('./index')

  expect(exposeInMainWorld).toHaveBeenCalledOnce()
  expect(exposeInMainWorld).toHaveBeenCalledWith('glade', {})
})
