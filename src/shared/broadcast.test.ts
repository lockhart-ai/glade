import { describe, expect, it } from 'vitest'
import { receivesBroadcast, type BroadcastFields } from './broadcast'
import { TaskActivity, TaskState } from './domain'

/** An active task that has never been given anything: no session, nothing running. */
const NEW: BroadcastFields = { state: TaskState.Active, activity: TaskActivity.Waiting, sessionId: null }

describe('receivesBroadcast', () => {
  it('leaves out a task that has never been given anything: it has no agent', () => {
    expect(receivesBroadcast(NEW)).toBe(false)
  })

  it('reaches an active task whose agent has run, whatever it is doing now', () => {
    for (const activity of Object.values(TaskActivity)) {
      expect(receivesBroadcast({ ...NEW, activity, sessionId: 'session-1' })).toBe(true)
    }
  })

  it('reaches a task whose first turn is under way, before its session is known', () => {
    expect(receivesBroadcast({ ...NEW, activity: TaskActivity.Working })).toBe(true)
    // Or paused in that first turn: it resumes on its own.
    expect(receivesBroadcast({ ...NEW, activity: TaskActivity.Paused })).toBe(true)
  })

  it('reaches a task an error stopped in its first turn, before it had a session', () => {
    expect(receivesBroadcast({ ...NEW, activity: TaskActivity.Error })).toBe(true)
  })

  it('never reaches a done task, run or not', () => {
    expect(receivesBroadcast({ ...NEW, state: TaskState.Done })).toBe(false)
    expect(receivesBroadcast({ state: TaskState.Done, activity: TaskActivity.Waiting, sessionId: 'session-1' })).toBe(
      false,
    )
    expect(receivesBroadcast({ state: TaskState.Done, activity: TaskActivity.Working, sessionId: null })).toBe(false)
  })
})
