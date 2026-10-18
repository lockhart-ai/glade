import { expect, it, vi } from 'vitest'
import { createGithubTokenCache } from './token'

it('reads the token once, and answers every call with it until invalidated', async () => {
  const read = vi.fn().mockResolvedValue('ghs_sample')
  const cache = createGithubTokenCache(read)

  expect(await cache.get()).toBe('ghs_sample')
  expect(await cache.get()).toBe('ghs_sample')

  expect(read).toHaveBeenCalledOnce()
})

it('shares one read between calls made while it is in flight', async () => {
  let resolve: (token: string) => void = () => undefined
  const read = vi.fn().mockReturnValue(
    new Promise<string>((r) => {
      resolve = r
    }),
  )
  const cache = createGithubTokenCache(read)

  const first = cache.get()
  const second = cache.get()
  resolve('ghs_sample')

  expect(await first).toBe('ghs_sample')
  expect(await second).toBe('ghs_sample')
  expect(read).toHaveBeenCalledOnce()
})

it('reads again after invalidate, as on a 401', async () => {
  const read = vi.fn().mockResolvedValueOnce('ghs_old').mockResolvedValueOnce('ghs_new')
  const cache = createGithubTokenCache(read)

  expect(await cache.get()).toBe('ghs_old')
  cache.invalidate()
  expect(await cache.get()).toBe('ghs_new')
  expect(read).toHaveBeenCalledTimes(2)
})

it('tries again next time when gh has no token to give, rather than caching null forever', async () => {
  const read = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('ghs_sample')
  const cache = createGithubTokenCache(read)

  expect(await cache.get()).toBeNull()
  expect(await cache.get()).toBe('ghs_sample')
  expect(read).toHaveBeenCalledTimes(2)
})
