import { describe, expect, it } from 'vitest'
import { TaskActivity, TaskState } from '../../shared/domain'
import { sampleTask } from '../store/test-bridge'
import { formatAgo, formatDay, isNewTask, pillLabel, timing } from './headerModel'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const STARTED = new Date(2026, 8, 23, 10, 42).getTime()
const DONE = new Date(2026, 8, 23, 11, 26).getTime()

describe('formatAgo', () => {
  it.each([
    [0, 'just now'],
    [59_999, 'just now'],
    [-5 * MINUTE, 'just now'],
    [MINUTE, '1m ago'],
    [4 * MINUTE + 30_000, '4m ago'],
    [59 * MINUTE, '59m ago'],
    [2 * HOUR, '2h ago'],
    [HOUR + 49 * MINUTE, '1h 49m ago'],
    [24 * HOUR, '1d ago'],
    [80 * HOUR, '3d ago'],
  ])('says %i ms ago as %s', (elapsed, expected) => {
    expect(formatAgo(1_000_000_000 - elapsed, 1_000_000_000)).toBe(expected)
  })
})

describe('formatDay', () => {
  it('gives the month and day', () => {
    expect(formatDay(DONE)).toBe('Sep 23')
  })
})

describe('isNewTask', () => {
  it('is new until the agent sets any of its title, objective or status', () => {
    expect(isNewTask({ title: '', objective: '', status: '' })).toBe(true)
    expect(isNewTask({ title: 'Fix it', objective: '', status: '' })).toBe(false)
    expect(isNewTask({ title: '', objective: 'Fix it', status: '' })).toBe(false)
    expect(isNewTask({ title: '', objective: '', status: 'Reading' })).toBe(false)
  })
})

describe('pillLabel', () => {
  const active = { state: TaskState.Active, doneAt: null, updatedAt: STARTED }

  it.each([
    [TaskActivity.Working, 'Active · working'],
    [TaskActivity.Waiting, 'Active · waiting on you'],
    [TaskActivity.Error, 'Active · stopped by an error'],
  ])('labels an active task that is %s', (activity, expected) => {
    expect(pillLabel({ ...active, activity })).toBe(expected)
  })

  it('labels a done task with the day it was done', () => {
    const done = { state: TaskState.Done, activity: TaskActivity.Waiting, updatedAt: STARTED }
    expect(pillLabel({ ...done, doneAt: DONE })).toBe('Done · Sep 23')
    expect(pillLabel({ ...done, doneAt: null })).toBe('Done · Sep 23')
  })
})

describe('timing', () => {
  const task = { ...sampleTask('t1', 'w1', 'Add rate limiting'), createdAt: STARTED, updatedAt: STARTED }

  it('says how long ago an active task was started', () => {
    expect(timing(task, STARTED + 42 * MINUTE)).toBe('started 42m ago')
  })

  it('says a new task was created', () => {
    expect(timing({ ...task, title: '' }, STARTED + 10_000)).toBe('created just now')
  })

  it('gives the clock times a done task ran between', () => {
    expect(timing({ ...task, state: TaskState.Done, doneAt: DONE }, DONE)).toBe('10:42 – 11:26')
    expect(timing({ ...task, state: TaskState.Done, doneAt: null, updatedAt: DONE }, DONE)).toBe('10:42 – 11:26')
  })
})
