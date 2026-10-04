// What resumes the tasks a usage limit paused, on its own: a database of paused tasks and a stand-in for the runner.
// `usage-resume.integration.test.ts` runs it behind the real bridge, runner and account.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsageLevel, UsageLimitKind, type UsageLimit, type UsageSnapshot } from '../../shared/account'
import { EventType } from '../../shared/bridge'
import { PauseReason, TaskActivity, TaskState, type Task } from '../../shared/domain'
import { USAGE_RECHECK_MS } from '../agent/pauses'
import { getTask, updateTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { createMemoryLog } from '../logging/memory-sink'
import { createUsageResume, resumeUsageLimitPauses, type UsageResume } from './usage-resume'

const NOW = 1_790_000_000_000
const HOUR = 3_600_000
const SESSION: UsageLimit = { kind: UsageLimitKind.Session }

let database: TestDatabase
let workspaceId: string
let resume: UsageResume | null
let clock: number

/** A stand-in for the runner: resuming a task sets it working, and usage is asked of a session that never answers. */
function fakeRunner(live = true) {
  return {
    resumePaused: vi.fn((taskId: string) => {
      updateTask(database.db, taskId, { activity: TaskActivity.Working, pause: null })
    }),
    refreshUsage: vi.fn(() => live),
  }
}

/** A task paused by `reason`, on the session limit when it's a usage limit. */
function paused(reason = PauseReason.UsageLimit): Task {
  clock += 1
  const task = sampleTask(database.db, workspaceId, clock)
  const limit = reason === PauseReason.UsageLimit ? { limit: SESSION } : {}
  const pause = { reason, since: NOW, resumesAt: NOW + HOUR, checks: 0, details: 'Limit.', ...limit }
  return updateTask(database.db, task.id, { activity: TaskActivity.Paused, pause })
}

function current(task: Task): Task {
  const found = getTask(database.db, task.id)
  if (found === undefined) throw new Error('The task is gone')
  return found
}

/** A reading: the session limit `session` used, and extra usage available or not. */
function reading(session: number, extraUsageAvailable = false): UsageSnapshot {
  const level = session >= 1 ? UsageLevel.Limited : UsageLevel.Within
  return {
    readings: [{ limit: SESSION, utilization: session, resetsAt: NOW + HOUR, level, readAt: NOW }],
    extraUsageAvailable,
  }
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  database = openTestDatabase()
  workspaceId = sampleWorkspace(database.db).id
  resume = null
  clock = 2_000
})

afterEach(() => {
  resume?.close()
  database.close()
  vi.useRealTimers()
})

describe('resumeUsageLimitPauses', () => {
  it('resumes the tasks a usage limit paused, oldest first, and leaves the rest', () => {
    const first = paused()
    const away = paused(PauseReason.Offline)
    const second = paused()
    const done = updateTask(database.db, paused().id, { state: TaskState.Done })
    const idle = sampleTask(database.db, workspaceId, 9_000)
    const runner = fakeRunner()
    const log = createMemoryLog()

    const resumed = resumeUsageLimitPauses({ db: database.db, runner, log: log.logger })

    expect(runner.resumePaused.mock.calls).toEqual([[first.id], [second.id]])
    expect(resumed.map(({ id, activity }) => [id, activity])).toEqual([
      [first.id, TaskActivity.Working],
      [second.id, TaskActivity.Working],
    ])
    for (const task of [away, done]) expect(current(task).activity).toBe(TaskActivity.Paused)
    expect(current(idle).activity).toBe(TaskActivity.Waiting)
    expect(log.withMessage('tasks paused on a usage limit resumed')[0]?.fields).toEqual({ tasks: 2 })
  })

  it('resumes only the tasks it’s given, and none of them that isn’t paused on a usage limit', () => {
    const first = paused()
    const second = paused()
    const away = paused(PauseReason.Offline)
    const runner = fakeRunner()

    const resumed = resumeUsageLimitPauses({ db: database.db, runner }, new Set([second.id, away.id, 'no-such-task']))

    expect(resumed.map(({ id }) => id)).toEqual([second.id])
    expect(current(first).activity).toBe(TaskActivity.Paused)
    expect(current(away).activity).toBe(TaskActivity.Paused)
  })
})

describe('createUsageResume', () => {
  it('times its reads by the clock and resumes with no batch to gather them, when given neither', () => {
    const task = paused()
    const runner = fakeRunner()
    resume = createUsageResume({ db: database.db, runner })

    vi.advanceTimersByTime(USAGE_RECHECK_MS)
    expect(runner.refreshUsage).toHaveBeenCalledOnce()
    // The clock moved on with the timer: a focus right after is the same read.
    resume.focused()
    expect(runner.refreshUsage).toHaveBeenCalledOnce()

    resume.usageRead(reading(0.2))
    expect(runner.resumePaused).toHaveBeenCalledExactlyOnceWith(task.id)
  })

  it('knows the tasks a usage limit had paused at launch, and no other', () => {
    paused(PauseReason.Offline)
    updateTask(database.db, paused().id, { state: TaskState.Done })
    const runner = fakeRunner()
    resume = createUsageResume({ db: database.db, runner })

    vi.advanceTimersByTime(3 * USAGE_RECHECK_MS)
    resume.focused()
    expect(runner.refreshUsage).not.toHaveBeenCalled()

    paused()
    resume.close()
    resume = createUsageResume({ db: database.db, runner })
    vi.advanceTimersByTime(USAGE_RECHECK_MS)
    expect(runner.refreshUsage).toHaveBeenCalledOnce()
  })

  it('follows the events: a task pausing on a usage limit starts the reads, and its leaving ends them', () => {
    const runner = fakeRunner()
    resume = createUsageResume({ db: database.db, runner })
    const task = paused()
    const away = paused(PauseReason.Offline)

    // Events about anything else, and a task paused offline, change nothing.
    resume.observe({ type: EventType.TaskUpdated, task: away })
    resume.observe({ type: EventType.AccountChanged, status: { account: null, usage: [] } })
    resume.focused()
    expect(runner.refreshUsage).not.toHaveBeenCalled()

    resume.observe({ type: EventType.TaskUpdated, task })
    resume.observe({ type: EventType.TaskUpdated, task })
    vi.advanceTimersByTime(USAGE_RECHECK_MS)
    expect(runner.refreshUsage).toHaveBeenCalledOnce()

    resume.observe({ type: EventType.TaskUpdated, task: { ...task, activity: TaskActivity.Working, pause: null } })
    vi.advanceTimersByTime(3 * USAGE_RECHECK_MS)
    expect(runner.refreshUsage).toHaveBeenCalledOnce()
  })

  it('reads again on the next focus when there was no session to ask', () => {
    paused()
    const runner = fakeRunner(false)
    const log = createMemoryLog()
    resume = createUsageResume({ db: database.db, runner, log: log.logger, now: () => NOW })

    resume.focused()
    resume.focused()

    expect(runner.refreshUsage).toHaveBeenCalledTimes(2)
    expect(log.withMessage('usage not asked for again: no session is live')).toHaveLength(2)
  })

  it('puts a reading to nothing while no task is paused on a usage limit', () => {
    const runner = fakeRunner()
    resume = createUsageResume({ db: database.db, runner })
    const read = vi.spyOn(database.db, 'prepare')

    resume.usageRead(reading(0.2, true))

    expect(read).not.toHaveBeenCalled()
    expect(runner.resumePaused).not.toHaveBeenCalled()
  })

  it('resumes each task once on what a reading says, and gathers them in one batch', () => {
    const first = paused()
    const second = paused()
    const runner = fakeRunner()
    const batches: number[] = []
    resume = createUsageResume({
      db: database.db,
      runner,
      batch: (run) => {
        const before = runner.resumePaused.mock.calls.length
        const result = run()
        batches.push(runner.resumePaused.mock.calls.length - before)
        return result
      },
    })

    resume.usageRead(reading(1))
    expect(batches).toEqual([])

    resume.usageRead(reading(1, true))
    expect(batches).toEqual([2])
    expect(runner.resumePaused.mock.calls).toEqual([[first.id], [second.id]])

    // Both are turned away again, and the reading says the same: nothing more.
    for (const task of [first, second]) {
      updateTask(database.db, task.id, { activity: TaskActivity.Paused, pause: task.pause })
    }
    resume.usageRead(reading(1, true))
    expect(batches).toEqual([2])
  })

  it('forgets what a deleted task was told', () => {
    const task = paused()
    const runner = fakeRunner()
    resume = createUsageResume({ db: database.db, runner })
    resume.usageRead(reading(1, true))
    updateTask(database.db, task.id, { activity: TaskActivity.Paused, pause: task.pause })
    resume.usageRead(reading(1, true))
    expect(runner.resumePaused).toHaveBeenCalledOnce()

    resume.observe({ type: EventType.TaskDeleted, taskId: task.id })
    resume.observe({ type: EventType.TaskUpdated, task: current(task) })
    resume.usageRead(reading(1, true))

    expect(runner.resumePaused).toHaveBeenCalledTimes(2)
  })
})
