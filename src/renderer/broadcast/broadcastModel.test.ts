import { describe, expect, it } from 'vitest'
import { TaskAttention } from '../../shared/attention'
import { TaskState, type Task } from '../../shared/domain'
import { sampleTask, sampleWorkspace } from '../store/test-bridge'
import {
  attentionLabel,
  broadcastFailureMessage,
  reachText,
  recipientCount,
  recipientTaskIds,
  recipientWorkspaceIds,
  undeliveredMessage,
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

describe('who a broadcast reaches', () => {
  const state = {
    workspaces: WORKSPACES,
    tasks: tasks(
      { ...sampleTask('a-old', 'w1'), updatedAt: 1_000 },
      { ...sampleTask('a-new', 'w1'), updatedAt: 3_000 },
      { ...sampleTask('a-pinned', 'w1'), updatedAt: 500, pinned: true },
      done(sampleTask('a-done', 'w1')),
      { ...done(sampleTask('a-done-pinned', 'w1')), pinned: true },
      { ...sampleTask('s-only', 'w2'), updatedAt: 2_000 },
      done(sampleTask('d-done', 'w3')),
      // A task whose workspace the window doesn't have isn't listed anywhere, so it isn't counted either.
      sampleTask('gone', 'w9'),
    ),
  }

  it('is every active task, in the workspaces that have one, oldest workspace first', () => {
    expect(recipientWorkspaceIds(state)).toEqual(['w1', 'w2'])
  })

  it('lists a workspace’s active tasks as its task list does: pinned first, then most recently updated', () => {
    expect(recipientTaskIds(state, 'w1')).toEqual(['a-pinned', 'a-new', 'a-old'])
    expect(recipientTaskIds(state, 'w2')).toEqual(['s-only'])
    expect(recipientTaskIds(state, 'w3')).toEqual([])
  })

  it('counts exactly the tasks it lists', () => {
    const listed = recipientWorkspaceIds(state).flatMap((workspaceId) => recipientTaskIds(state, workspaceId))
    expect(recipientCount(state)).toBe(listed.length)
    expect(recipientCount(state)).toBe(4)
  })

  it('reaches no one with no active task', () => {
    const none = { workspaces: WORKSPACES, tasks: tasks(done(sampleTask('a-done', 'w1'))) }
    expect(recipientWorkspaceIds(none)).toEqual([])
    expect(recipientCount(none)).toBe(0)
  })
})

describe('what the modal says', () => {
  it('says how many tasks in how many workspaces, one or several', () => {
    expect(reachText(9, 3)).toBe('9 active tasks in 3 workspaces')
    expect(reachText(1, 1)).toBe('1 active task in 1 workspace')
    expect(reachText(2, 1)).toBe('2 active tasks in 1 workspace')
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
