import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GithubChecksState, GithubLinkKind, GithubLinkState } from '../../../shared/githubWatch'
import { type Task } from '../../../shared/domain'
import { addLinkArtifact } from './artifacts'
import { getGithubLinkWatch, listGithubLinkWatches, listWatchedLinks, putGithubLinkWatch } from './github-link-watches'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'

let test: TestDatabase
let task: Task

const URL = 'https://github.com/acme/api/pull/412'
const ISSUE_URL = 'https://github.com/acme/api/issues/7'

beforeEach(() => {
  test = openTestDatabase()
  task = sampleTask(test.db, sampleWorkspace(test.db).id)
  addLinkArtifact(test.db, { taskId: task.id, url: URL, title: '#412' })
  addLinkArtifact(test.db, { taskId: task.id, url: ISSUE_URL, title: '#7' })
})

afterEach(() => {
  test.close()
})

const watch = (overrides: Partial<Parameters<typeof putGithubLinkWatch>[1]> = {}) =>
  putGithubLinkWatch(test.db, {
    taskId: task.id,
    url: URL,
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
    ...overrides,
  })

describe('putGithubLinkWatch', () => {
  it('declares a watch for one of the task’s links, readable back the same way', () => {
    const put = watch()

    expect(put).toEqual({
      taskId: task.id,
      url: URL,
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
      lastFetchedAt: expect.any(Number) as unknown,
    })
    expect(getGithubLinkWatch(test.db, task.id, URL)).toEqual(put)
  })

  it('replaces what it had for the same task and link, not adding another row', () => {
    watch()
    const updated = watch({
      state: GithubLinkState.Closed,
      merged: true,
      checksState: GithubChecksState.Success,
      checksSummary: '14/14',
      commentCount: 3,
      watching: false,
    })

    expect(updated.state).toBe(GithubLinkState.Closed)
    expect(updated.merged).toBe(true)
    expect(updated.watching).toBe(false)
    expect(listGithubLinkWatches(test.db, task.id)).toEqual([updated])
  })

  it('refuses a watch for a URL that is not one of the task’s link artifacts', () => {
    expect(() => watch({ url: 'https://github.com/acme/api/pull/999' })).toThrow(/FOREIGN KEY/)
  })
})

describe('listGithubLinkWatches', () => {
  it('lists only this task’s watches, whether still watching or not', () => {
    const other = sampleTask(test.db, task.workspaceId)
    addLinkArtifact(test.db, { taskId: other.id, url: URL, title: '#412' })
    putGithubLinkWatch(test.db, {
      taskId: other.id,
      url: URL,
      kind: GithubLinkKind.PullRequest,
      state: GithubLinkState.Open,
      merged: false,
      draft: false,
      inMergeQueue: false,
      checksState: null,
      checksSummary: null,
      reviewState: null,
      commentCount: 0,
      headOid: null,
      title: 'Elsewhere',
      watching: true,
    })
    const mine = watch({ watching: false })

    expect(listGithubLinkWatches(test.db, task.id)).toEqual([mine])
  })
})

describe('listWatchedLinks', () => {
  it('lists every link still being watched, across tasks, but not one that stopped', () => {
    const watching = watch()
    const stopped = putGithubLinkWatch(test.db, {
      taskId: task.id,
      url: ISSUE_URL,
      kind: GithubLinkKind.Issue,
      state: GithubLinkState.Closed,
      merged: false,
      draft: false,
      inMergeQueue: false,
      checksState: null,
      checksSummary: null,
      reviewState: null,
      commentCount: 1,
      headOid: null,
      title: 'Flaky test',
      watching: false,
    })

    const all = listWatchedLinks(test.db)
    expect(all).toContainEqual(watching)
    expect(all).not.toContainEqual(stopped)
  })
})
