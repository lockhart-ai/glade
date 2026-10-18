import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskState, TodoState, type Task } from '../../shared/domain'
import { GithubLinkKind, GithubChecksState, GithubLinkState } from '../../shared/githubWatch'
import { ChildKind, FilingSource } from '../../shared/todoHub'
import { addArtifact, addLinkArtifact } from '../db/repositories/artifacts'
import { putFilings } from '../db/repositories/child-filings'
import { putGithubLinkWatch } from '../db/repositories/github-link-watches'
import { putTodos } from '../db/repositories/glade-todos'
import { updateTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { watchCandidates } from './targets'

let test: TestDatabase
let task: Task

beforeEach(() => {
  test = openTestDatabase()
  task = sampleTask(test.db, sampleWorkspace(test.db).id)
})

afterEach(() => {
  test.close()
})

const PR_URL = 'https://github.com/acme/api/pull/412'
const ISSUE_URL = 'https://github.com/acme/api/issues/7'

describe('watchCandidates', () => {
  it('finds a GitHub PR and issue link, with no previous state, no todo filed, and when each was linked', () => {
    const pr = addLinkArtifact(test.db, { taskId: task.id, url: PR_URL, title: '#412' })
    addLinkArtifact(test.db, { taskId: task.id, url: ISSUE_URL, title: '#7' })
    addArtifact(test.db, { taskId: task.id, path: 'notes.md', title: 'Notes' })

    const candidates = watchCandidates(test.db)

    expect(candidates).toHaveLength(2)
    expect(candidates.map((c) => c.target.url)).toEqual([PR_URL, ISSUE_URL])
    expect(candidates[0]).toMatchObject({
      target: {
        taskId: task.id,
        url: PR_URL,
        owner: 'acme',
        repo: 'api',
        number: 412,
        kind: GithubLinkKind.PullRequest,
      },
      previous: undefined,
      linkedAt: pr.addedAt,
      todoDone: false,
    })
    expect(candidates[1]?.target).toMatchObject({ kind: GithubLinkKind.Issue, number: 7 })
  })

  it('leaves out a link that is not a GitHub PR or issue', () => {
    addLinkArtifact(test.db, { taskId: task.id, url: 'https://example.com/docs', title: 'Docs' })

    expect(watchCandidates(test.db)).toEqual([])
  })

  it('leaves out a task that is not active', () => {
    addLinkArtifact(test.db, { taskId: task.id, url: PR_URL, title: '#412' })
    updateTask(test.db, task.id, { state: TaskState.Done })

    expect(watchCandidates(test.db)).toEqual([])
  })

  it('carries forward what was last fetched, when there is some', () => {
    addLinkArtifact(test.db, { taskId: task.id, url: PR_URL, title: '#412' })
    const watch = putGithubLinkWatch(test.db, {
      taskId: task.id,
      url: PR_URL,
      kind: GithubLinkKind.PullRequest,
      state: GithubLinkState.Open,
      merged: false,
      draft: false,
      inMergeQueue: false,
      checksState: GithubChecksState.Pending,
      checksSummary: null,
      reviewState: null,
      commentCount: 0,
      headOid: 'abc123',
      title: 'Port the chat cases',
      watching: true,
    })

    expect(watchCandidates(test.db)[0]?.previous).toEqual(watch)
  })

  it('leaves out a link that has already stopped being watched', () => {
    addLinkArtifact(test.db, { taskId: task.id, url: PR_URL, title: '#412' })
    putGithubLinkWatch(test.db, {
      taskId: task.id,
      url: PR_URL,
      kind: GithubLinkKind.PullRequest,
      state: GithubLinkState.Closed,
      merged: true,
      draft: false,
      inMergeQueue: false,
      checksState: GithubChecksState.Success,
      checksSummary: '14/14',
      reviewState: 'APPROVED',
      commentCount: 1,
      headOid: 'abc123',
      title: 'Port the chat cases',
      watching: false,
    })

    expect(watchCandidates(test.db)).toEqual([])
  })

  it('says a link’s todo is done when its filing’s todo is marked done', () => {
    addLinkArtifact(test.db, { taskId: task.id, url: PR_URL, title: '#412' })
    putTodos(test.db, task.id, [{ id: '1', text: 'Review #412', note: null, state: TodoState.Done, completedAt: 1 }])
    putFilings(test.db, task.id, [{ kind: ChildKind.Link, key: PR_URL, todoId: '1', source: FilingSource.Named }])

    expect(watchCandidates(test.db)[0]?.todoDone).toBe(true)
  })

  it('is not done while its todo is still open, or it is not filed under one at all', () => {
    addLinkArtifact(test.db, { taskId: task.id, url: PR_URL, title: '#412' })
    putTodos(test.db, task.id, [
      { id: '1', text: 'Review #412', note: null, state: TodoState.Doing, completedAt: null },
    ])
    putFilings(test.db, task.id, [{ kind: ChildKind.Link, key: PR_URL, todoId: '1', source: FilingSource.Named }])

    expect(watchCandidates(test.db)[0]?.todoDone).toBe(false)
  })
})
