import { describe, expect, it } from 'vitest'
import { TaskActivity, TaskState, type Task } from '../../shared/domain'
import { sampleTask, sampleWorkspace } from '../store/test-bridge'
import {
  badgeTone,
  BadgeTone,
  describeStatus,
  otherWorkspacesNeedsYouCount,
  pillText,
  switcherTitle,
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

  it('counts a read reply still working in the background as active only, and an unread one as needing you whether or not background work runs (#461)', () => {
    const read = { ...waiting('t1'), unread: false }
    const readBackground = { ...read, backgroundWork: true }
    const unreadBackground = { ...waiting('t2'), backgroundWork: true }
    expect(workspaceStatus([read, readBackground], 'w1')).toEqual({ kind: WorkspaceStatusKind.Active, count: 2 })
    // The unread one needs you though its background work runs (#461).
    expect(workspaceStatus([readBackground, unreadBackground], 'w1')).toEqual({
      kind: WorkspaceStatusKind.NeedsYou,
      count: 1,
    })

    // Its background work finishes while it's still unread: it already needed you, so nothing changes.
    expect(workspaceStatus([readBackground, { ...unreadBackground, backgroundWork: false }], 'w1')).toEqual({
      kind: WorkspaceStatusKind.NeedsYou,
      count: 1,
    })
    // The read one is marked unread too: now both need you.
    expect(workspaceStatus([{ ...readBackground, unread: true }, unreadBackground], 'w1')).toEqual({
      kind: WorkspaceStatusKind.NeedsYou,
      count: 2,
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

describe('otherWorkspacesNeedsYouCount', () => {
  it('is 0 with nothing needing you, or only the current workspace’s own tasks needing you', () => {
    expect(otherWorkspacesNeedsYouCount([], 'w1')).toBe(0)
    expect(otherWorkspacesNeedsYouCount([waiting('t1'), waiting('t2')], 'w1')).toBe(0)
  })

  it('counts tasks that need you across every other workspace, never the current one', () => {
    const elsewhere = [waiting('t1', 'w2'), waiting('t2', 'w3'), working('t3', 'w2')]
    expect(otherWorkspacesNeedsYouCount(elsewhere, 'w1')).toBe(2)
    // The same tasks, now that w2 is current: w2's own no longer counts, w3's still does.
    expect(otherWorkspacesNeedsYouCount(elsewhere, 'w2')).toBe(1)
  })

  it('counts every workspace when none is current', () => {
    expect(otherWorkspacesNeedsYouCount([waiting('t1', 'w1'), waiting('t2', 'w2')], null)).toBe(2)
  })
})

describe('pillText', () => {
  it('is the count, or 9+ past nine', () => {
    expect(pillText(1)).toBe('1')
    expect(pillText(9)).toBe('9')
    expect(pillText(10)).toBe('9+')
    expect(pillText(42)).toBe('9+')
  })
})

describe('switcherTitle', () => {
  it('is just "Switch workspace" at 0', () => {
    expect(switcherTitle(0)).toBe('Switch workspace')
  })

  it('says how many tasks in other workspaces need you, past 0, with the exact count (not 9+)', () => {
    expect(switcherTitle(1)).toBe('Switch workspace — 1 task in other workspaces needs you')
    expect(switcherTitle(3)).toBe('Switch workspace — 3 tasks in other workspaces need you')
    expect(switcherTitle(10)).toBe('Switch workspace — 10 tasks in other workspaces need you')
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
