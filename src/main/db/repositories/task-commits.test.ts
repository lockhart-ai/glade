import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '../../../shared/domain'
import {
  addTaskCommit,
  CommitSource,
  findTaskCommit,
  getTaskCommit,
  listTaskCommits,
  reassignTaskCommit,
  removeTaskCommit,
  type NewTaskCommit,
} from './task-commits'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'
import { appendToolCall } from './tool-events'

let test: TestDatabase
let task: Task
let other: Task

beforeEach(() => {
  test = openTestDatabase()
  const workspace = sampleWorkspace(test.db)
  task = sampleTask(test.db, workspace.id)
  other = sampleTask(test.db, workspace.id, 3_000)
})

afterEach(() => {
  test.close()
})

function commit(hash: string, overrides: Partial<NewTaskCommit> = {}): NewTaskCommit {
  return {
    taskId: task.id,
    gitDir: '/code/acme-api/.git',
    repoPath: '/code/acme-api',
    hash: hash.repeat(40).slice(0, 40),
    subject: `Commit ${hash}`,
    branch: 'main',
    committedAt: 10_000,
    additions: 3,
    deletions: 1,
    filesChanged: 2,
    parents: 1,
    toolUseId: null,
    source: CommitSource.Printed,
    ...overrides,
  }
}

describe('the task commits', () => {
  it('keep each link with what the tab shows, and find it by repository and hash, or by id', () => {
    const added = addTaskCommit(test.db, commit('a'), 42)
    expect(added).toMatchObject({ attributedAt: 42, subject: 'Commit a' })
    expect(getTaskCommit(test.db, added.id)).toEqual(added)
    expect(findTaskCommit(test.db, '/code/acme-api/.git', added.hash)).toEqual(added)
    expect(findTaskCommit(test.db, '/code/acme-web/.git', added.hash)).toBeUndefined()
    expect(getTaskCommit(test.db, 'nope')).toBeUndefined()
  })

  it('list a task’s newest first, those of one second the last linked first, with the subagent that made each', () => {
    appendToolCall(test.db, {
      taskId: task.id,
      turn: 1,
      name: 'Bash',
      input: { command: 'git commit' },
      toolUseId: 'toolu_bash',
      parentToolUseId: 'toolu_agent',
    })
    addTaskCommit(test.db, commit('a', { committedAt: 1_000 }))
    addTaskCommit(test.db, commit('b', { committedAt: 5_000, toolUseId: 'toolu_bash', parents: 2 }))
    addTaskCommit(test.db, commit('c', { committedAt: 5_000, branch: null }))
    addTaskCommit(test.db, commit('d', { taskId: other.id }))
    expect(
      listTaskCommits(test.db, task.id).map(({ subject, merge, subagentToolUseId, branch }) => [
        subject,
        merge,
        subagentToolUseId,
        branch,
      ]),
    ).toEqual([
      ['Commit c', false, null, null],
      ['Commit b', true, 'toolu_agent', 'main'],
      ['Commit a', false, null, 'main'],
    ])
    expect(listTaskCommits(test.db, other.id).map(({ subject }) => subject)).toEqual(['Commit d'])
  })

  it('move a link to another task, and remove one', () => {
    const added = addTaskCommit(test.db, commit('a', { source: CommitSource.Observed }))
    reassignTaskCommit(test.db, added.id, {
      taskId: other.id,
      toolUseId: 'toolu_2',
      source: CommitSource.Printed,
      branch: 'fix/date-test',
    })
    expect(getTaskCommit(test.db, added.id)).toMatchObject({
      taskId: other.id,
      toolUseId: 'toolu_2',
      source: CommitSource.Printed,
      branch: 'fix/date-test',
    })
    removeTaskCommit(test.db, added.id)
    expect(listTaskCommits(test.db, other.id)).toEqual([])
  })
})
