import { describe, expect, it } from 'vitest'
import { hasRun, isWorking, needsYou, TaskAttention, taskAttention, type AttentionFields } from './attention'
import { TaskActivity, TaskState } from './domain'

/** A task that has run, whose turn ended with a reply you've read, and nothing running. */
const READ: AttentionFields = {
  state: TaskState.Active,
  activity: TaskActivity.Waiting,
  sessionId: 'session-1',
  asking: false,
  awaitingPermission: false,
  unread: false,
  backgroundWork: false,
}
const UNREAD: AttentionFields = { ...READ, unread: true }
const BACKGROUND: AttentionFields = { ...READ, backgroundWork: true }

const { NeedsYou, Working, Idle } = TaskAttention

describe('hasRun', () => {
  it('is true once the task has a session, or its first turn failed before it got one', () => {
    expect(hasRun(READ)).toBe(true)
    expect(hasRun({ ...READ, sessionId: null, activity: TaskActivity.Error })).toBe(true)
    expect(hasRun({ ...READ, sessionId: null })).toBe(false)
  })
})

describe('taskAttention', () => {
  it.each<[string, AttentionFields, TaskAttention]>([
    // The turn ended with a reply.
    ['with a reply you have read, and nothing running', READ, Idle],
    ['with a reply you have not read', UNREAD, NeedsYou],
    // Blocked on you, read or not.
    ['asking you questions', { ...READ, asking: true }, NeedsYou],
    ['asking, whatever its activity says', { ...READ, activity: TaskActivity.Working, asking: true }, NeedsYou],
    ['waiting on your OK for a tool call', { ...READ, awaitingPermission: true }, NeedsYou],
    [
      'waiting on your OK, whatever its activity says',
      { ...READ, activity: TaskActivity.Working, awaitingPermission: true },
      NeedsYou,
    ],
    ['stopped by an error you have seen', { ...READ, activity: TaskActivity.Error }, NeedsYou],
    [
      'stopped by an error before it got a session',
      { ...READ, sessionId: null, activity: TaskActivity.Error },
      NeedsYou,
    ],
    // Its own turn.
    ['working', { ...READ, activity: TaskActivity.Working }, Working],
    ['working, and unread from an earlier reply', { ...UNREAD, activity: TaskActivity.Working }, Working],
    ['paused, since it resumes on its own', { ...READ, activity: TaskActivity.Paused }, Working],
    // Background work, once its own turn has ended.
    ['with a read reply and background work running', BACKGROUND, Working],
    ['with an unread reply and background work running', { ...BACKGROUND, unread: true }, NeedsYou],
    ['asking while background work runs', { ...BACKGROUND, asking: true }, NeedsYou],
    ['waiting on your OK while background work runs', { ...BACKGROUND, awaitingPermission: true }, NeedsYou],
    ['stopped by an error while background work runs', { ...BACKGROUND, activity: TaskActivity.Error }, NeedsYou],
    // Never run: nothing to show you yet.
    ['brand new, never run', { ...READ, sessionId: null }, Idle],
    ['brand new, marked unread', { ...UNREAD, sessionId: null }, Idle],
    // Done.
    ['done', { ...READ, state: TaskState.Done }, Idle],
    ['done and unread', { ...UNREAD, state: TaskState.Done }, Idle],
    ['done, with a question still open', { ...READ, state: TaskState.Done, asking: true }, Idle],
    ['done, with a permission request still open', { ...READ, state: TaskState.Done, awaitingPermission: true }, Idle],
    ['done with an error', { ...READ, state: TaskState.Done, activity: TaskActivity.Error }, Idle],
    ['done, with background work running', { ...BACKGROUND, state: TaskState.Done }, Idle],
  ])('a task %s → %s', (_, task, expected) => {
    expect(taskAttention(task)).toBe(expected)
    expect(needsYou(task)).toBe(expected === NeedsYou)
    expect(isWorking(task)).toBe(expected === Working)
  })

  it('follows a reply through being read, marked unread, and background work finishing', () => {
    // A reply lands while subagents still run: unread needs you, background work or not (#461).
    const replied: AttentionFields = { ...BACKGROUND, unread: true }
    expect(taskAttention(replied)).toBe(NeedsYou)
    // Background work ending while it's still unread changes nothing: it already needed you.
    const finished: AttentionFields = { ...replied, backgroundWork: false }
    expect(taskAttention(finished)).toBe(NeedsYou)
    // You open the task: read, and background work has ended, so it's idle.
    const opened: AttentionFields = { ...finished, unread: false }
    expect(taskAttention(opened)).toBe(Idle)
    // Mark as unread: it needs you again.
    expect(taskAttention({ ...opened, unread: true })).toBe(NeedsYou)
    // A read reply with background work running counts as working, not idle or needing you.
    const stillRunning: AttentionFields = { ...opened, backgroundWork: true }
    expect(taskAttention(stillRunning)).toBe(Working)
    // A reply arriving while it's working in the background needs you straight away.
    expect(taskAttention({ ...stillRunning, unread: true })).toBe(NeedsYou)
  })
})
