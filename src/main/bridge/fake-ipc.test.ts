import { expect, it } from 'vitest'
import { fakeIpcPair } from './fake-ipc'

it('rejects an invoke on a channel nothing handles, as Electron does', async () => {
  await expect(fakeIpcPair().renderer.invoke('nowhere')).rejects.toThrow('No handler for nowhere')
})
