import { describe, expect, it } from 'vitest'
import { TaskAttention } from '../../shared/attention'
import { TaskActivity, TaskState, type Task } from '../../shared/domain'
import { sampleTask, sampleWorkspace } from '../store/test-bridge'
import {
  attentionLabel,
  broadcastFailureMessage,
  NOTHING_TICKED,
  reachText,
  recipientCount,
  recipientIds,
  recipientTaskIds,
  recipientWorkspaceIds,
  setTicked,
  tickedCounts,
  undeliveredMessage,
  WorkspaceTick,
  workspaceTick,
} from './broadcastModel'

const WORKSPACES = [
  sampleWorkspace('w1', 'Acme API'),
  sampleWorkspace('w2', 'Storefront'),
  sampleWorkspace('w3', 'Docs'),
]

function tasks(...list: Task[]): Record<string, Task> {
  return Object.fromEntries(list.map((task) => [task.id, task]))
}

const done = (task: Task): Task => ({ ...task, state: TaskState.Done, doneAt: 5_000 })

/** A task whose agent has run: it has a session. (`sampleTask` alone has never been given anything.) */
const ran = (task: Task): Task => ({ ...task, sessionId: `session-${task.id}` })

describe('who a broadcast reaches', () => {
  const state = {
    workspaces: WORKSPACES,
    tasks: tasks(
      { ...ran(sampleTask('a-old', 'w1')), updatedAt: 1_000 },
      { ...ran(sampleTask('a-new', 'w1')), updatedAt: 3_000 },
      { ...ran(sampleTask('a-pinned', 'w1')), updatedAt: 500, pinned: true },
      // Its first turn is under way: it has an agent, though its session isn't known yet.
      { ...sampleTask('a-starting', 'w1'), updatedAt: 200, activity: TaskActivity.Working },
      // Never given anything: no agent to ask. The newest in its workspace, and still not listed.
      { ...sampleTask('a-untouched', 'w1'), updatedAt: 9_000 },
      done(ran(sampleTask('a-done', 'w1'))),
      { ...done(ran(sampleTask('a-done-pinned', 'w1'))), pinned: true },
      { ...ran(sampleTask('s-only', 'w2')), updatedAt: 2_000 },
      done(ran(sampleTask('d-done', 'w3'))),
      // A workspace whose only active task has never been given anything isn't listed either.
      sampleTask('d-untouched', 'w3'),
      // A task whose workspace the window doesn't have isn't listed anywhere, so it isn't counted either.
      ran(sampleTask('gone', 'w9')),
    ),
  }

  it('is every active task that has an agent, in the workspaces that have one, oldest workspace first', () => {
    expect(recipientWorkspaceIds(state)).toEqual(['w1', 'w2'])
  })

  it('lists a workspace’s recipients as its task list does: pinned first, then most recently updated', () => {
    expect(recipientTaskIds(state, 'w1')).toEqual(['a-pinned', 'a-new', 'a-old', 'a-starting'])
    expect(recipientTaskIds(state, 'w2')).toEqual(['s-only'])
    expect(recipientTaskIds(state, 'w3')).toEqual([])
  })

  it('leaves out a task that has never been given anything, and counts one whose first turn is under way', () => {
    const listed = recipientWorkspaceIds(state).flatMap((workspaceId) => recipientTaskIds(state, workspaceId))
    expect(listed).not.toContain('a-untouched')
    expect(listed).not.toContain('d-untouched')
    expect(listed).toContain('a-starting')
  })

  it('counts exactly the tasks it lists', () => {
    const listed = recipientWorkspaceIds(state).flatMap((workspaceId) => recipientTaskIds(state, workspaceId))
    expect(recipientCount(state)).toBe(listed.length)
    expect(recipientCount(state)).toBe(5)
  })

  it('reaches no one with no active task, or with only ones that have never been given anything', () => {
    const none = { workspaces: WORKSPACES, tasks: tasks(done(ran(sampleTask('a-done', 'w1')))) }
    expect(recipientWorkspaceIds(none)).toEqual([])
    expect(recipientCount(none)).toBe(0)

    const untouched = { workspaces: WORKSPACES, tasks: tasks(sampleTask('a-new', 'w1'), sampleTask('s-new', 'w2')) }
    expect(recipientWorkspaceIds(untouched)).toEqual([])
    expect(recipientTaskIds(untouched, 'w1')).toEqual([])
    expect(recipientCount(untouched)).toBe(0)
  })

  it("lists every recipient in one flat list, each workspace's tasks in its order", () => {
    expect(recipientIds(state)).toEqual(['a-pinned', 'a-new', 'a-old', 'a-starting', 's-only'])
  })
})

describe('what the tick boxes tick (#675)', () => {
  const state = {
    workspaces: WORKSPACES,
    tasks: tasks(
      ran(sampleTask('a1', 'w1')),
      ran(sampleTask('a2', 'w1')),
      ran(sampleTask('s1', 'w2')),
      ran(sampleTask('s2', 'w2')),
      ran(sampleTask('s3', 'w2')),
    ),
  }
  const all = ['a1', 'a2', 's1', 's2', 's3']

  it('opens with everything ticked, and counts the recipients', () => {
    const unticked = new Set<string>()
    expect(tickedCounts(state, unticked)).toEqual({ tasks: 5, workspaces: 2 })
    expect(workspaceTick(unticked, ['a1', 'a2'])).toBe(WorkspaceTick.All)
    expect(workspaceTick(unticked, ['s1', 's2', 's3'])).toBe(WorkspaceTick.All)
  })

  it('shows a workspace as half-ticked when only some of its tasks are, and counts only the ticked', () => {
    const unticked = new Set(['s2'])
    expect(workspaceTick(unticked, ['s1', 's2', 's3'])).toBe(WorkspaceTick.Some)
    expect(workspaceTick(unticked, ['a1', 'a2'])).toBe(WorkspaceTick.All)
    expect(tickedCounts(state, unticked)).toEqual({ tasks: 4, workspaces: 2 })
  })

  it('shows a workspace as unticked when all of its tasks are, and leaves it out of the count', () => {
    const unticked = new Set(['s1', 's2', 's3'])
    expect(workspaceTick(unticked, ['s1', 's2', 's3'])).toBe(WorkspaceTick.None)
    expect(tickedCounts(state, unticked)).toEqual({ tasks: 2, workspaces: 1 })
  })

  it('counts nothing, and no workspace, with every task unticked', () => {
    expect(tickedCounts(state, new Set(all))).toEqual({ tasks: 0, workspaces: 0 })
  })

  it('a task row is all or none, never some', () => {
    expect(workspaceTick(new Set(['a1']), ['a1'])).toBe(WorkspaceTick.None)
    expect(workspaceTick(new Set(['s2']), ['s2'])).toBe(WorkspaceTick.None)
  })

  it('ticks one task, leaving the others as they were', () => {
    const unticked = setTicked(new Set(['s2', 'a1']), ['s2'], true)
    expect(unticked).toEqual(new Set(['a1']))
    // The set it was asked with is left alone, so an untick that never lands can't leave the modal stuck.
    expect(setTicked(new Set(['a1']), ['a1'], true)).toEqual(new Set())
  })

  it("unticks one task, and unticks and re-ticks a workspace's all at once", () => {
    const one = setTicked(new Set<string>(), ['s2'], false)
    expect(one).toEqual(new Set(['s2']))

    const workspace = setTicked(one, ['s1', 's2', 's3'], false)
    expect(workspace).toEqual(new Set(['s1', 's2', 's3']))
    expect(setTicked(workspace, ['s1', 's2', 's3'], true)).toEqual(new Set())
  })
})

describe('what the modal says', () => {
  it('says how many of the tasks are ticked, of how many, in how many workspaces, one or several', () => {
    expect(reachText(6, 9, 2)).toBe('6 of 9 active tasks in 2 workspaces')
    expect(reachText(1, 1, 1)).toBe('1 of 1 active task in 1 workspace')
    expect(reachText(0, 2, 1)).toBe('0 of 2 active tasks in 1 workspace')
  })

  it('says what to do with nothing ticked', () => {
    expect(NOTHING_TICKED).toBe('Nothing ticked. Tick a task to send to it.')
  })

  it('says where each task stands with you', () => {
    expect(attentionLabel(TaskAttention.NeedsYou)).toBe('needs you')
    expect(attentionLabel(TaskAttention.Working)).toBe('working')
    expect(attentionLabel(TaskAttention.Idle)).toBe('idle')
  })

  it('names the one task that couldn’t take it and why, or counts several', () => {
    expect(undeliveredMessage([{ title: 'Fix flaky login test', message: 'spawn claude ENOENT' }])).toBe(
      'Couldn’t send to “Fix flaky login test”: spawn claude ENOENT',
    )
    expect(
      undeliveredMessage([
        { title: 'Fix flaky login test', message: 'spawn claude ENOENT' },
        { title: 'Move image uploads to S3', message: 'spawn claude ENOENT' },
      ]),
    ).toBe('Couldn’t send to 2 tasks.')
  })

  it('says why the whole broadcast failed', () => {
    expect(broadcastFailureMessage('tasks.broadcast failed: database is locked')).toBe(
      'Couldn’t send your broadcast: tasks.broadcast failed: database is locked',
    )
  })
})
