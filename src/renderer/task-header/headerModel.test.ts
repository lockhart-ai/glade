import { describe, expect, it } from 'vitest'
import { DividerKind, TaskActivity, TaskState, ToolEventKind, type ToolEvent } from '../../shared/domain'
import { sampleTask } from '../store/test-bridge'
import {
  age,
  ageTitle,
  canMarkDone,
  formatAge,
  formatAgo,
  formatDay,
  formatFullDate,
  isNewTask,
  offersMarkDone,
  reopening,
  stateLabel,
  type Reopening,
} from './headerModel'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const STARTED = new Date(2026, 8, 23, 10, 42).getTime()
const DONE = new Date(2026, 8, 23, 11, 26).getTime()

describe('formatAge', () => {
  it.each([
    [0, 'now'],
    [59_999, 'now'],
    [-5 * MINUTE, 'now'],
    [MINUTE, '1m'],
    [4 * MINUTE + 30_000, '4m'],
    [42 * MINUTE, '42m'],
    [59 * MINUTE + 59_999, '59m'],
    [HOUR, '1h'],
    [2 * HOUR, '2h'],
    [HOUR + 49 * MINUTE, '1h 49m'],
    [23 * HOUR + 59 * MINUTE, '23h 59m'],
    [24 * HOUR, '1d'],
    [80 * HOUR, '3d'],
    [400 * 24 * HOUR, '400d'],
  ])('gives %i ms as %s', (elapsed, expected) => {
    expect(formatAge(1_000_000_000 - elapsed, 1_000_000_000)).toBe(expected)
  })
})

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

describe('formatFullDate', () => {
  it('gives the date, year and time', () => {
    expect(formatFullDate(STARTED)).toBe('Sep 23, 2026, 10:42 AM')
    expect(formatFullDate(new Date(2027, 0, 5, 21, 7).getTime())).toBe('Jan 5, 2027, 9:07 PM')
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
    ['a paused task', { ...task, activity: TaskActivity.Paused }, true, true],
    ['a new task', { ...task, title: '' }, false, false],
    ['a done task', { ...task, state: TaskState.Done }, false, false],
  ])('for %s: offered %s, allowed %s', (_, value, offered, allowed) => {
    expect(offersMarkDone(value)).toBe(offered)
    expect(canMarkDone(value)).toBe(allowed)
  })
})

describe('stateLabel', () => {
  const active = { state: TaskState.Active, doneAt: null, updatedAt: STARTED }

  it.each([
    [TaskActivity.Working, 'Active · working'],
    [TaskActivity.Waiting, 'Active · waiting on you'],
    [TaskActivity.Error, 'Active · stopped by an error'],
    [TaskActivity.Paused, 'Active · paused'],
  ])('labels an active task that is %s', (activity, expected) => {
    expect(stateLabel({ ...active, activity })).toBe(expected)
  })

  it('labels a done task with the day it was done', () => {
    const done = { state: TaskState.Done, activity: TaskActivity.Waiting, updatedAt: STARTED }
    expect(stateLabel({ ...done, doneAt: DONE })).toBe('Done · Sep 23')
    expect(stateLabel({ ...done, doneAt: null })).toBe('Done · Sep 23')
  })
})

describe('age', () => {
  const task = { ...sampleTask('t1', 'w1', 'Add rate limiting'), createdAt: STARTED, updatedAt: STARTED }

  it('says how old an active task is', () => {
    expect(age(task, STARTED + 42 * MINUTE)).toBe('42m')
    expect(age(task, STARTED + HOUR + 49 * MINUTE)).toBe('1h 49m')
    expect(age(task, STARTED + 3 * 24 * HOUR)).toBe('3d')
  })

  it('says a task created under a minute ago is new', () => {
    expect(age(task, STARTED + 10_000)).toBe('now')
  })

  it('gives the clock times a done task ran between', () => {
    expect(age({ ...task, state: TaskState.Done, doneAt: DONE }, DONE)).toBe('10:42 – 11:26')
    expect(age({ ...task, state: TaskState.Done, doneAt: null, updatedAt: DONE }, DONE)).toBe('10:42 – 11:26')
  })
})

describe('ageTitle', () => {
  const task = { ...sampleTask('t1', 'w1', 'Add rate limiting'), createdAt: STARTED, updatedAt: STARTED }

  it('gives the full date an active task was started', () => {
    expect(ageTitle(task)).toBe('Started Sep 23, 2026, 10:42 AM')
  })

  it('says a new task was created', () => {
    expect(ageTitle({ ...task, title: '' })).toBe('Created Sep 23, 2026, 10:42 AM')
  })

  it('adds when a done task was done', () => {
    expect(ageTitle({ ...task, state: TaskState.Done, doneAt: DONE })).toBe(
      'Started Sep 23, 2026, 10:42 AM · done Sep 23, 2026, 11:26 AM',
    )
    expect(ageTitle({ ...task, state: TaskState.Done, doneAt: null, updatedAt: DONE })).toBe(
      'Started Sep 23, 2026, 10:42 AM · done Sep 23, 2026, 11:26 AM',
    )
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
    parentToolUseId: null,
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
    expect(stateLabel({ ...active, activity: TaskActivity.Working }, reopened)).toBe('Active · reopened')
    expect(stateLabel({ ...active, activity: TaskActivity.Working }, { ...reopened, latestTurn: false })).toBe(
      'Active · working',
    )
    expect(stateLabel({ ...active, activity: TaskActivity.Waiting }, reopened)).toBe('Active · waiting on you')
  })

  it('keeps its age, and its tooltip adds when it was first done and reopened', () => {
    const REOPENED = new Date(2026, 8, 25, 9, 14).getTime()
    const again: Reopening = { ...reopened, reopenedAt: REOPENED }
    expect(age(task, REOPENED)).toBe('1d')
    expect(ageTitle(task, again)).toBe(
      'Started Sep 23, 2026, 10:42 AM · first done Sep 23, 2026, 11:26 AM · reopened Sep 25, 2026, 9:14 AM',
    )
    expect(ageTitle({ ...task, state: TaskState.Done, doneAt: REOPENED + HOUR }, again)).toBe(
      'Started Sep 23, 2026, 10:42 AM · first done Sep 23, 2026, 11:26 AM · reopened Sep 25, 2026, 9:14 AM · done Sep 25, 2026, 10:14 AM',
    )
  })
})
