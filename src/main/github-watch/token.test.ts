import { execFile } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { createGithubTokenCache, GH_TOKEN_TIMEOUT_MS, readGhToken } from './token'

// `gh` itself, faked: a test never runs the machine's own `gh`.
vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

type ExecFileCallback = (error: Error | null, stdout: string) => void

/** Has the faked `gh auth token` answer with `error` or `stdout`. */
function answerGh(error: Error | null, stdout: string): void {
  vi.mocked(execFile).mockImplementationOnce(((
    _file: string,
    _args: string[],
    _options: object,
    callback: ExecFileCallback,
  ) => {
    callback(error, stdout)
  }) as unknown as typeof execFile)
}

it('reads the token with `gh auth token`, trimmed, with a timeout and no shell', async () => {
  answerGh(null, 'ghs_sample\n')

  expect(await readGhToken()).toBe('ghs_sample')
  expect(execFile).toHaveBeenCalledWith(
    'gh',
    ['auth', 'token'],
    { timeout: GH_TOKEN_TIMEOUT_MS, encoding: 'utf8' },
    expect.any(Function),
  )
})

it('answers null when `gh` fails or prints nothing', async () => {
  answerGh(new Error('not logged in'), '')
  expect(await readGhToken()).toBeNull()

  answerGh(null, '  \n')
  expect(await readGhToken()).toBeNull()
})

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
