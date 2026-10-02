import { describe, expect, it } from 'vitest'
import { TaskActivity, TaskState, type Task } from '../../shared/domain'
import { sampleTask, sampleWorkspace } from '../store/test-bridge'
import {
  badgeTone,
  BadgeTone,
  describeStatus,
  workspaceAt,
  workspaceInitial,
  workspaceStatus,
  WorkspaceStatusKind,
} from './switcherModel'

/** A task in `workspaceId` whose agent is working. */
function working(id: string, workspaceId = 'w1'): Task {
  return { ...sampleTask(id, workspaceId), activity: TaskActivity.Working, sessionId: 's' }
}

/** A task in `workspaceId` whose agent has replied, which you haven't read. */
function waiting(id: string, workspaceId = 'w1'): Task {
  return { ...sampleTask(id, workspaceId), activity: TaskActivity.Waiting, sessionId: 's', unread: true }
}

function done(id: string, workspaceId = 'w1'): Task {
  return { ...waiting(id, workspaceId), state: TaskState.Done }
}

describe('workspaceStatus', () => {
  it('is idle with no active tasks: none at all, only done ones, or only in other workspaces', () => {
    expect(workspaceStatus([], 'w1')).toEqual({ kind: WorkspaceStatusKind.Idle })
    expect(workspaceStatus([done('t1'), working('t2', 'w2')], 'w1')).toEqual({ kind: WorkspaceStatusKind.Idle })
  })

  it('counts the active tasks, a brand-new one included, when none needs you', () => {
    const fresh = sampleTask('t3', 'w1')

    expect(workspaceStatus([working('t1'), working('t2'), fresh, done('t4')], 'w1')).toEqual({
      kind: WorkspaceStatusKind.Active,
      count: 3,
    })
  })

  it('counts the tasks that need you ahead of the active ones', () => {
    const asking = { ...working('t3'), asking: true }
    const errored = { ...working('t4'), activity: TaskActivity.Error }

    expect(workspaceStatus([working('t1'), waiting('t2'), asking, errored, waiting('t5', 'w2')], 'w1')).toEqual({
      kind: WorkspaceStatusKind.NeedsYou,
      count: 3,
    })
  })

  it('counts a reply you have read, and a task still working in the background, as active only (#430)', () => {
    const read = { ...waiting('t1'), unread: false }
    const background = { ...waiting('t2'), backgroundWork: true }
    expect(workspaceStatus([read, background], 'w1')).toEqual({ kind: WorkspaceStatusKind.Active, count: 2 })

    // The background work finishes on its unread reply; the read one is marked unread.
    expect(workspaceStatus([read, { ...background, backgroundWork: false }], 'w1')).toEqual({
      kind: WorkspaceStatusKind.NeedsYou,
      count: 1,
    })
    expect(workspaceStatus([{ ...read, unread: true }, background], 'w1')).toEqual({
      kind: WorkspaceStatusKind.NeedsYou,
      count: 1,
    })
    // Asking or erroring needs you whatever runs in the background, and whether it's read.
    const asking = { ...read, backgroundWork: true, asking: true }
    const errored = { ...read, backgroundWork: true, activity: TaskActivity.Error }
    expect(workspaceStatus([asking, errored], 'w1')).toEqual({ kind: WorkspaceStatusKind.NeedsYou, count: 2 })
  })
})

describe('describeStatus', () => {
  it('words each status as the design does', () => {
    expect(describeStatus({ kind: WorkspaceStatusKind.Active, count: 3 })).toBe('3 active')
    expect(describeStatus({ kind: WorkspaceStatusKind.NeedsYou, count: 1 })).toBe('1 needs you')
    expect(describeStatus({ kind: WorkspaceStatusKind.Idle })).toBe('idle')
  })
})

describe('badgeTone', () => {
  const workspaces = ['w1', 'w2', 'w3', 'w4', 'w5'].map((id) => sampleWorkspace(id))

  it('gives the workspaces the design’s colours in turn, oldest first', () => {
    expect(workspaces.map(({ id }) => badgeTone(workspaces, id))).toEqual([
      BadgeTone.Blue,
      BadgeTone.Purple,
      BadgeTone.Teal,
      BadgeTone.Pink,
      BadgeTone.Blue,
    ])
  })

  it('is blue for a workspace it does not know', () => {
    expect(badgeTone(workspaces, 'gone')).toBe(BadgeTone.Blue)
  })
})

describe('workspaceInitial', () => {
  it('is the first character, upper-cased, or ? for no name', () => {
    expect(workspaceInitial('acme API')).toBe('A')
    expect(workspaceInitial('élan')).toBe('É')
    expect(workspaceInitial('')).toBe('?')
  })
})

describe('workspaceAt', () => {
  const workspaces = ['w1', 'w2', 'w3'].map((id) => sampleWorkspace(id))

  it('is the nth workspace for ⌘n, oldest first, and none past the last or outside 1 – 9', () => {
    expect(workspaceAt(workspaces, 1)?.id).toBe('w1')
    expect(workspaceAt(workspaces, 3)?.id).toBe('w3')
    expect(workspaceAt(workspaces, 4)).toBeUndefined()
    expect(workspaceAt(workspaces, 0)).toBeUndefined()
    expect(workspaceAt(workspaces, 10)).toBeUndefined()
  })
})
