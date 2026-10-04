import { expect, it, vi } from 'vitest'
import type { GladeBridge } from '../shared/bridge'

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn<(key: string, api: object) => void>(),
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  getPathForFile: vi.fn<(file: File) => string>(() => '/tmp/acme-api/exports/sales.csv'),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: electron.ipcRenderer,
  webUtils: { getPathForFile: electron.getPathForFile },
}))

it('exposes the bridge to the renderer as window.glade', async () => {
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['/Applications/Glade.app', '--glade-home=/Users/sample'])
  await import('./index')

  expect(electron.exposeInMainWorld).toHaveBeenCalledOnce()
  const [key, api] = electron.exposeInMainWorld.mock.calls[0] ?? []
  expect(key).toBe('glade')
  expect(api).toEqual({
    invoke: expect.any(Function) as unknown,
    subscribe: expect.any(Function) as unknown,
    pathForFile: expect.any(Function) as unknown,
    // The home folder main named in the window's arguments.
    homeFolder: '/Users/sample',
  })

  // A dropped or pasted file is named by its path on disk, through Electron's webUtils.
  const file = new File(['region,total\n'], 'sales.csv')

  expect((api as GladeBridge).pathForFile(file)).toBe('/tmp/acme-api/exports/sales.csv')
  expect(electron.getPathForFile).toHaveBeenCalledWith(file)
})
