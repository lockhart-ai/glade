import { describe, expect, it } from 'vitest'
import { hasRun, matchesFilter, needsYou, parseTaskFilter, TaskFilter } from './attention'
import { TaskActivity, TaskState, type Task } from './domain'

type Attention = Pick<Task, 'state' | 'activity' | 'sessionId' | 'asking' | 'unread'>

const RAN: Attention = {
  state: TaskState.Active,
  activity: TaskActivity.Waiting,
  sessionId: 'session-1',
  asking: false,
  unread: false,
}

describe('hasRun', () => {
  it('is true once the task has a session, or its first turn failed before it got one', () => {
    expect(hasRun(RAN)).toBe(true)
    expect(hasRun({ ...RAN, sessionId: null, activity: TaskActivity.Error })).toBe(true)
    expect(hasRun({ ...RAN, sessionId: null })).toBe(false)
  })
})

describe('needsYou', () => {
  it.each([
    ['waiting on you', RAN, true],
    ['errored', { ...RAN, activity: TaskActivity.Error }, true],
    ['working', { ...RAN, activity: TaskActivity.Working }, false],
    ['paused, since it resumes on its own', { ...RAN, activity: TaskActivity.Paused }, false],
    ['done', { ...RAN, state: TaskState.Done }, false],
    ['brand new, never run', { ...RAN, sessionId: null }, false],
    ['asking you questions', { ...RAN, asking: true }, true],
    [
      'asking you questions, whatever its activity says',
      { ...RAN, activity: TaskActivity.Working, asking: true },
      true,
    ],
    ['done, with a question still open', { ...RAN, state: TaskState.Done, asking: true }, false],
  ])('is %s → %s', (_, task, expected) => {
    expect(needsYou(task)).toBe(expected)
  })
})

describe('matchesFilter', () => {
  it('lets every task through All, and only the matching ones through Needs you and Unread', () => {
    const working: Attention = { ...RAN, activity: TaskActivity.Working, unread: true }

    expect([RAN, working].map((task) => matchesFilter(task, TaskFilter.All))).toEqual([true, true])
    expect([RAN, working].map((task) => matchesFilter(task, TaskFilter.NeedsYou))).toEqual([true, false])
    expect([RAN, working].map((task) => matchesFilter(task, TaskFilter.Unread))).toEqual([false, true])
  })
})

describe('parseTaskFilter', () => {
  it('reads a stored filter, and falls back to All', () => {
    expect(parseTaskFilter('needs_you')).toBe(TaskFilter.NeedsYou)
    expect(parseTaskFilter('unread')).toBe(TaskFilter.Unread)
    expect(parseTaskFilter('all')).toBe(TaskFilter.All)
    expect(parseTaskFilter(undefined)).toBe(TaskFilter.All)
    expect(parseTaskFilter('starred')).toBe(TaskFilter.All)
  })
})
