import { describe, expect, it } from 'vitest'
import { DividerKind, TaskActivity, TaskState, ToolEventKind, type ToolEvent } from '../../shared/domain'
import { sampleTask } from '../store/test-bridge'
import {
  canMarkDone,
  formatAgo,
  formatDay,
  isNewTask,
  offersMarkDone,
  pillLabel,
  reopening,
  timing,
  type Reopening,
} from './headerModel'

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

describe('offersMarkDone and canMarkDone', () => {
  const task = { ...sampleTask('t1', 'w1', 'Fix it'), activity: TaskActivity.Waiting }

  it.each([
    ['an active task the agent has set up', task, true, true],
    ['a task stopped by an error', { ...task, activity: TaskActivity.Error }, true, true],
    ['a task whose agent is working', { ...task, activity: TaskActivity.Working }, true, false],
    ['a new task', { ...task, title: '' }, false, false],
    ['a done task', { ...task, state: TaskState.Done }, false, false],
  ])('for %s: offered %s, allowed %s', (_, value, offered, allowed) => {
    expect(offersMarkDone(value)).toBe(offered)
    expect(canMarkDone(value)).toBe(allowed)
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

describe('reopening', () => {
  const REOPENED = new Date(2026, 8, 25, 9, 14).getTime()
  const at = (dividerKind: DividerKind, turn: number, createdAt: number): ToolEvent => ({
    id: `${dividerKind}-${String(createdAt)}`,
    taskId: 't1',
    turn,
    createdAt,
    kind: ToolEventKind.Divider,
    dividerKind,
  })
  const narration = (turn: number): ToolEvent => ({
    id: `n${String(turn)}`,
    taskId: 't1',
    turn,
    createdAt: REOPENED,
    kind: ToolEventKind.Narration,
    text: 'Reading',
  })
  const firstReopen = [
    at(DividerKind.Turn, 1, STARTED),
    at(DividerKind.MarkedDone, 1, DONE),
    at(DividerKind.Reopened, 2, REOPENED),
    at(DividerKind.Turn, 2, REOPENED),
    narration(2),
  ]

  it('is null until a message reopens the task', () => {
    expect(reopening([])).toBeNull()
    expect(reopening([at(DividerKind.Turn, 1, STARTED), narration(1)])).toBeNull()
  })

  it('is when it was last reopened and first done, and whether the reopening turn is the latest', () => {
    expect(reopening(firstReopen)).toEqual({ reopenedAt: REOPENED, firstDoneAt: DONE, latestTurn: true })
    const again = [
      ...firstReopen,
      at(DividerKind.Turn, 3, REOPENED + HOUR),
      at(DividerKind.MarkedDone, 3, REOPENED + 2 * HOUR),
      at(DividerKind.Reopened, 4, REOPENED + 3 * HOUR),
    ]
    expect(reopening(again)).toEqual({ reopenedAt: REOPENED + 3 * HOUR, firstDoneAt: DONE, latestTurn: true })
    expect(reopening([...firstReopen, at(DividerKind.Turn, 3, REOPENED + HOUR)])).toMatchObject({ latestTurn: false })
  })
})

describe('a reopened task', () => {
  const reopened: Reopening = { reopenedAt: STARTED + HOUR, firstDoneAt: DONE, latestTurn: true }
  const task = { ...sampleTask('t1', 'w1', 'Fix it'), createdAt: STARTED }

  it('says it was reopened while the agent works on the reopening message, and its usual label otherwise', () => {
    const active = { state: TaskState.Active, doneAt: null, updatedAt: STARTED }
    expect(pillLabel({ ...active, activity: TaskActivity.Working }, reopened)).toBe('Active · reopened')
    expect(pillLabel({ ...active, activity: TaskActivity.Working }, { ...reopened, latestTurn: false })).toBe(
      'Active · working',
    )
    expect(pillLabel({ ...active, activity: TaskActivity.Waiting }, reopened)).toBe('Active · waiting on you')
  })

  it('shows when it was reopened and first done, until it is done again', () => {
    expect(timing(task, STARTED + HOUR, reopened)).toBe('reopened just now · first done Sep 23')
    expect(timing(task, STARTED + 2 * HOUR + 5 * MINUTE, reopened)).toBe('reopened 1h 5m ago · first done Sep 23')
    expect(timing({ ...task, state: TaskState.Done, doneAt: DONE }, DONE, reopened)).toBe('10:42 – 11:26')
  })
})
