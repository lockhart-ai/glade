import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentRunner } from '../agent/runner'
import { MIN_BACKOFF_MS } from './backoff'
import type { PollOptions } from './poller'
import { createGithubWatcher, type GithubWatcherOptions } from './watcher'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function options(poll: (options: PollOptions) => Promise<number>): GithubWatcherOptions {
  return {
    db: {} as never,
    emit: vi.fn(),
    runner: { send: vi.fn<AgentRunner['send']>(), queue: vi.fn<AgentRunner['queue']>() },
    poll,
  }
}

it('polls once as soon as it starts', async () => {
  const poll = vi.fn().mockResolvedValue(60_000)
  const watcher = createGithubWatcher(options(poll))

  watcher.start()
  await vi.advanceTimersByTimeAsync(0)

  expect(poll).toHaveBeenCalledOnce()
})

it('polls again after whatever the poll said to wait, and again after that', async () => {
  const poll = vi.fn().mockResolvedValueOnce(60_000).mockResolvedValueOnce(60_000).mockResolvedValue(60_000)
  const watcher = createGithubWatcher(options(poll))

  watcher.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(poll).toHaveBeenCalledTimes(1)

  await vi.advanceTimersByTimeAsync(60_000)
  expect(poll).toHaveBeenCalledTimes(2)

  await vi.advanceTimersByTimeAsync(60_000)
  expect(poll).toHaveBeenCalledTimes(3)
})

it('waits a backoff’s length instead, when the poll says to', async () => {
  const poll = vi.fn().mockResolvedValueOnce(90_000).mockResolvedValue(60_000)
  const watcher = createGithubWatcher(options(poll))

  watcher.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(poll).toHaveBeenCalledTimes(1)

  await vi.advanceTimersByTimeAsync(60_000)
  expect(poll).toHaveBeenCalledTimes(1)

  await vi.advanceTimersByTimeAsync(30_000)
  expect(poll).toHaveBeenCalledTimes(2)
})

it('does nothing for a second start while already running', async () => {
  const poll = vi.fn().mockResolvedValue(60_000)
  const watcher = createGithubWatcher(options(poll))

  watcher.start()
  watcher.start()
  await vi.advanceTimersByTimeAsync(0)

  expect(poll).toHaveBeenCalledOnce()
})

it('stops rescheduling once closed, even one already waiting', async () => {
  const poll = vi.fn().mockResolvedValue(60_000)
  const watcher = createGithubWatcher(options(poll))

  watcher.start()
  await vi.advanceTimersByTimeAsync(0)
  watcher.close()
  await vi.advanceTimersByTimeAsync(120_000)

  expect(poll).toHaveBeenCalledOnce()
})

it('retries after a poll that throws, rather than stopping for good', async () => {
  const poll = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValue(60_000)
  const log = { warn: vi.fn(), with: () => log } as never
  const watcher = createGithubWatcher({ ...options(poll), log })

  watcher.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(poll).toHaveBeenCalledTimes(1)
  expect((log as { warn: ReturnType<typeof vi.fn> }).warn).toHaveBeenCalledWith(
    'github watch poll failed',
    expect.objectContaining({ error: 'ECONNRESET' }),
  )

  await vi.advanceTimersByTimeAsync(MIN_BACKOFF_MS)
  expect(poll).toHaveBeenCalledTimes(2)
})
