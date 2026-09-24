import { describe, expect, it } from 'vitest'
import { Effort, TaskState, type Task } from './domain'
import { TaskIndicator, taskIndicator } from './taskIndicator'

function task(state: TaskState): Task {
  return {
    id: 't1',
    workspaceId: 'w1',
    title: '',
    objective: '',
    status: '',
    state,
    pinned: false,
    unread: false,
    model: 'claude-sample-1',
    effort: Effort.Medium,
    createdAt: 1,
    updatedAt: 1,
    doneAt: state === TaskState.Done ? 1 : null,
    sessionId: null,
  }
}

describe('taskIndicator', () => {
  it('shows an active task as waiting on you', () => {
    expect(taskIndicator(task(TaskState.Active))).toBe(TaskIndicator.Waiting)
  })

  it('shows a done task as done', () => {
    expect(taskIndicator(task(TaskState.Done))).toBe(TaskIndicator.Done)
  })
})
