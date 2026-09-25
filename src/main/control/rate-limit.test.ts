// The control API's rate limits: the limiter on its own, and the limits hit and recovered from through a real client.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '../../shared/domain'
import { sampleTask, sampleWorkspace } from '../db/repositories/test-database'
import { LogScope } from '../logging/logger'
import { ControlErrorCode } from './errors'
import { ControlAccess, ControlToolName } from './names'
import { CONTROL_RATE_LIMITS, createRateLimiter, RATE_WINDOW_MS } from './rate-limit'
import { asTask, connect, errorCode, HTTP, startControlApp, type ControlApp, type ControlClient } from './test-control'

describe('the limiter', () => {
  it('lets a caller make its limit of each access in a window, then says when the next may go', () => {
    let now = 1_000
    const limiter = createRateLimiter({ limits: { read: 3, change: 1 }, windowMs: 100, now: () => now })

    expect([1, 2, 3].map(() => limiter.take('a', ControlAccess.Read))).toEqual([
      { ok: true },
      { ok: true },
      { ok: true },
    ])
    now = 1_040
    expect(limiter.take('a', ControlAccess.Read)).toEqual({ ok: false, retryAfterMs: 60 })
    // Changes, and other callers, count apart.
    expect(limiter.take('a', ControlAccess.Change)).toEqual({ ok: true })
    expect(limiter.take('b', ControlAccess.Read)).toEqual({ ok: true })
    expect(limiter.take('a', ControlAccess.Change)).toEqual({ ok: false, retryAfterMs: 100 })
    // A refused call doesn't count: once the window has passed the first three, three more go.
    now = 1_100
    expect([1, 2, 3].map(() => limiter.take('a', ControlAccess.Read).ok)).toEqual([true, true, true])
    expect(limiter.take('a', ControlAccess.Read)).toEqual({ ok: false, retryAfterMs: 100 })
  })

  it('allows 3,000 reads and 1,200 changes a minute by default, enough for a backfill', () => {
    expect(CONTROL_RATE_LIMITS).toEqual({ read: 3000, change: 1200 })
    expect(RATE_WINDOW_MS).toBe(60_000)
    const limiter = createRateLimiter()
    for (let call = 0; call < 1200; call += 1) expect(limiter.take('a', ControlAccess.Change).ok).toBe(true)
    expect(limiter.take('a', ControlAccess.Change).ok).toBe(false)
  })
})

describe('through the tools', () => {
  let app: ControlApp
  let task: Task
  let client: ControlClient

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    app = startControlApp()
    task = sampleTask(app.database.db, sampleWorkspace(app.database.db).id)
    client = await connect(app.bridge.control.server(asTask('caller-task')))
  })

  afterEach(async () => {
    await client.close()
    await app.close()
    vi.useRealTimers()
  })

  it('refuses the 1,201st change in a minute with rate_limited and retryAfterMs, then lets it through once it may', async () => {
    for (let call = 0; call < 1200; call += 1) {
      vi.setSystemTime(1_000_000 + call * 25)
      const reply = await client.call(ControlToolName.UpdateTask, { id: task.id, patch: { status: String(call) } })
      expect(reply.isError).toBe(false)
    }

    vi.setSystemTime(1_030_000)
    const refused = await client.call(ControlToolName.UpdateTask, { id: task.id, patch: { status: 'too many' } })
    expect(errorCode(refused)).toBe(ControlErrorCode.RateLimited)
    expect(refused.json).toEqual({
      error: {
        code: 'rate_limited',
        message: 'Too many change calls in a minute; try again in 30s',
        retryAfterMs: 30_000,
      },
    })
    expect(app.bridge.control.service.getTask(task.id).status).toBe('1199')
    // Reads count apart, so they still go.
    expect((await client.call(ControlToolName.GetTask, { id: task.id })).isError).toBe(false)

    vi.setSystemTime(1_060_000)
    const allowed = await client.call(ControlToolName.UpdateTask, { id: task.id, patch: { status: 'again' } })
    expect(allowed.isError).toBe(false)
    const [limited] = app.log.inScope(LogScope.Control).filter((record) => record.fields.outcome === 'rate_limited')
    expect(limited?.fields).toMatchObject({ tool: 'update_task', caller: 'caller-task' })
  })

  it('refuses the 3,001st read in a minute, per caller: another caller still reads', async () => {
    for (let call = 0; call < 3000; call += 1) {
      expect((await client.call(ControlToolName.ListWorkspaces)).isError).toBe(false)
    }

    expect(errorCode(await client.call(ControlToolName.GetTask, { id: task.id }))).toBe(ControlErrorCode.RateLimited)
    const other = await connect(app.bridge.control.server(HTTP))
    expect((await other.call(ControlToolName.ListWorkspaces)).isError).toBe(false)
    await other.close()

    vi.setSystemTime(1_000_000 + 60_001)
    expect((await client.call(ControlToolName.ListWorkspaces)).isError).toBe(false)
  })
})
