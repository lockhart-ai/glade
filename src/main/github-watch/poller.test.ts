import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '../../shared/domain'
import { GithubChecksState, GithubLinkKind, GithubLinkState } from '../../shared/githubWatch'
import { ChildKind, FilingSource } from '../../shared/todoHub'
import { TodoState } from '../../shared/domain'
import { addLinkArtifact } from '../db/repositories/artifacts'
import { putFilings } from '../db/repositories/child-filings'
import { getGithubLinkWatch, putGithubLinkWatch } from '../db/repositories/github-link-watches'
import { putTodos } from '../db/repositories/glade-todos'
import { updateSettings } from '../db/repositories/settings'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import type { AgentRunner } from '../agent/runner'
import type { Emit } from '../bridge/events'
import type { Logger } from '../logging/logger'
import type { GraphqlBatchResult } from './graphql'
import { pollGithubWatches, type GithubPollState } from './poller'
import type { WatchTarget } from './query'
import type { RestBatchResult } from './rest-fallback'
import type { GithubTokenCache } from './token'

let test: TestDatabase
let task: Task

const PR_URL = 'https://github.com/acme/api/pull/412'

beforeEach(() => {
  test = openTestDatabase()
  task = sampleTask(test.db, sampleWorkspace(test.db).id)
})

afterEach(() => {
  test.close()
})

function tokenCache(token: string | null): GithubTokenCache {
  return { get: () => Promise.resolve(token), invalidate: vi.fn() }
}

function fetched(targets: readonly WatchTarget[], overrides: Record<string, unknown> = {}) {
  const map = new Map(
    targets.map((target) => [
      target,
      {
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
        mergedAt: null,
        closedAt: null,
        ...overrides,
      },
    ]),
  )
  return map
}

function runner(): {
  send: ReturnType<typeof vi.fn<AgentRunner['send']>>
  queue: ReturnType<typeof vi.fn<AgentRunner['queue']>>
} {
  return { send: vi.fn<AgentRunner['send']>(), queue: vi.fn<AgentRunner['queue']>() }
}

/** A logger a test can read, with only what the poller uses. */
function testLog() {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    scoped: () => log,
    with: () => log,
  }
  return log satisfies Logger
}

describe('pollGithubWatches', () => {
  it('asks GitHub nothing, and waits a full interval, when there is nothing to watch', async () => {
    const fetchGraphql = vi.fn()
    const waitMs = await pollGithubWatches({
      db: test.db,
      emit: vi.fn(),
      runner: runner(),
      tokenCache: tokenCache('ghs_token'),
      fetchGraphql,
    })

    expect(waitMs).toBe(60_000)
    expect(fetchGraphql).not.toHaveBeenCalled()
  })

  it('uses the configured interval', async () => {
    updateSettings(test.db, { githubWatchPollSeconds: 120 })

    expect(
      await pollGithubWatches({ db: test.db, emit: vi.fn(), runner: runner(), tokenCache: tokenCache(null) }),
    ).toBe(120_000)
  })

  it('polls with the token, writes what it found and emits it, but sends no message the first time', async () => {
    addLinkArtifact(test.db, { taskId: task.id, url: PR_URL, title: '#412' })
    const fetchGraphql = vi
      .fn()
      .mockImplementation((_token: string, targets: readonly WatchTarget[]) =>
        Promise.resolve({ outcome: 'fetched', fetched: fetched(targets) } satisfies GraphqlBatchResult),
      )
    const emit = vi.fn<Emit>()
    const theRunner = runner()

    await pollGithubWatches({ db: test.db, emit, runner: theRunner, tokenCache: tokenCache('ghs_token'), fetchGraphql })

    expect(fetchGraphql).toHaveBeenCalledWith('ghs_token', [
      expect.objectContaining({ taskId: task.id, url: PR_URL, kind: GithubLinkKind.PullRequest }),
    ])
    expect(getGithubLinkWatch(test.db, task.id, PR_URL)).toMatchObject({ title: 'Port the chat cases', watching: true })
    expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({ watch: { url: PR_URL } })
    expect(theRunner.send).not.toHaveBeenCalled()
    expect(theRunner.queue).not.toHaveBeenCalled()
  })

  it('wakes the task on the next poll, once something has changed', async () => {
    addLinkArtifact(test.db, { taskId: task.id, url: PR_URL, title: '#412' })
    const first = vi
      .fn()
      .mockImplementation((_t: string, targets: readonly WatchTarget[]) =>
        Promise.resolve({ outcome: 'fetched', fetched: fetched(targets) } satisfies GraphqlBatchResult),
      )
    await pollGithubWatches({
      db: test.db,
      emit: vi.fn(),
      runner: runner(),
      tokenCache: tokenCache('ghs_token'),
      fetchGraphql: first,
    })

    const second = vi.fn().mockImplementation((_t: string, targets: readonly WatchTarget[]) =>
      Promise.resolve({
        outcome: 'fetched',
        fetched: fetched(targets, { checksState: GithubChecksState.Failure, checksSummary: '13/14', commentCount: 2 }),
      } satisfies GraphqlBatchResult),
    )
    const theRunner = runner()
    theRunner.send.mockReturnValue({ id: 'm' } as unknown as ReturnType<AgentRunner['send']>)

    await pollGithubWatches({
      db: test.db,
      emit: vi.fn(),
      runner: theRunner,
      tokenCache: tokenCache('ghs_token'),
      fetchGraphql: second,
    })

    expect(theRunner.send).toHaveBeenCalledWith(
      task.id,
      ['GitHub:', '- PR #412 Port the chat cases: CI failed (13/14); 2 new comments'].join('\n'),
      [],
      [],
      [],
      'github',
    )
  })

  it('wakes the task on a link’s first fetch when it finds a merge after the link was added (#728)', async () => {
    const linked = addLinkArtifact(test.db, { taskId: task.id, url: PR_URL, title: '#412' })
    const fetchGraphql = vi.fn().mockImplementation((_t: string, targets: readonly WatchTarget[]) =>
      Promise.resolve({
        outcome: 'fetched',
        fetched: fetched(targets, {
          state: GithubLinkState.Closed,
          merged: true,
          mergedAt: linked.addedAt + 60_000,
          closedAt: linked.addedAt + 60_000,
        }),
      } satisfies GraphqlBatchResult),
    )
    const theRunner = runner()
    theRunner.send.mockReturnValue({ id: 'm' } as unknown as ReturnType<AgentRunner['send']>)

    await pollGithubWatches({
      db: test.db,
      emit: vi.fn(),
      runner: theRunner,
      tokenCache: tokenCache('ghs_token'),
      fetchGraphql,
    })

    expect(theRunner.send).toHaveBeenCalledWith(
      task.id,
      ['GitHub:', '- PR #412 Port the chat cases: merged'].join('\n'),
      [],
      [],
      [],
      'github',
    )
  })

  it('stays silent on a first fetch of a link that merged before it was added (#728)', async () => {
    const linked = addLinkArtifact(test.db, { taskId: task.id, url: PR_URL, title: '#412' })
    const fetchGraphql = vi.fn().mockImplementation((_t: string, targets: readonly WatchTarget[]) =>
      Promise.resolve({
        outcome: 'fetched',
        fetched: fetched(targets, {
          state: GithubLinkState.Closed,
          merged: true,
          mergedAt: linked.addedAt - 60_000,
          closedAt: linked.addedAt - 60_000,
        }),
      } satisfies GraphqlBatchResult),
    )
    const theRunner = runner()

    await pollGithubWatches({
      db: test.db,
      emit: vi.fn(),
      runner: theRunner,
      tokenCache: tokenCache('ghs_token'),
      fetchGraphql,
    })

    expect(theRunner.send).not.toHaveBeenCalled()
    expect(theRunner.queue).not.toHaveBeenCalled()
    expect(getGithubLinkWatch(test.db, task.id, PR_URL)).toMatchObject({
      state: GithubLinkState.Closed,
      merged: true,
      watching: false,
    })
  })

  it('keeps polling a link whose todo is done, updating its watch and emitting, but never waking the task (#738)', async () => {
    addLinkArtifact(test.db, { taskId: task.id, url: PR_URL, title: '#412' })
    const first = vi
      .fn()
      .mockImplementation((_t: string, targets: readonly WatchTarget[]) =>
        Promise.resolve({ outcome: 'fetched', fetched: fetched(targets) } satisfies GraphqlBatchResult),
      )
    await pollGithubWatches({
      db: test.db,
      emit: vi.fn(),
      runner: runner(),
      tokenCache: tokenCache('ghs_token'),
      fetchGraphql: first,
    })

    putTodos(test.db, task.id, [{ id: '1', text: 'Review #412', note: null, state: TodoState.Done, completedAt: 1 }])
    putFilings(test.db, task.id, [{ kind: ChildKind.Link, key: PR_URL, todoId: '1', source: FilingSource.Named }])
    const second = vi.fn().mockImplementation((_t: string, targets: readonly WatchTarget[]) =>
      Promise.resolve({
        outcome: 'fetched',
        fetched: fetched(targets, { checksState: GithubChecksState.Failure, checksSummary: '13/14', commentCount: 2 }),
      } satisfies GraphqlBatchResult),
    )
    const emit = vi.fn<Emit>()
    const theRunner = runner()
    const log = testLog()

    await pollGithubWatches({
      db: test.db,
      emit,
      runner: theRunner,
      tokenCache: tokenCache('ghs_token'),
      fetchGraphql: second,
      log,
    })

    expect(second).toHaveBeenCalledOnce()
    expect(getGithubLinkWatch(test.db, task.id, PR_URL)).toMatchObject({
      checksState: GithubChecksState.Failure,
      commentCount: 2,
      watching: true,
    })
    expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({
      watch: { url: PR_URL, checksState: GithubChecksState.Failure },
    })
    expect(theRunner.send).not.toHaveBeenCalled()
    expect(theRunner.queue).not.toHaveBeenCalled()
    // Its checks and comments changed, not its state: the log says nothing of it (#738).
    expect(log.info).not.toHaveBeenCalledWith(
      'github watch: links whose todo is done changed state, without waking their tasks',
      expect.anything(),
    )

    // Its state changes: that, and only that, is logged, and still nobody is woken.
    const third = vi.fn().mockImplementation((_t: string, targets: readonly WatchTarget[]) =>
      Promise.resolve({
        outcome: 'fetched',
        fetched: fetched(targets, { state: GithubLinkState.Closed, merged: true }),
      } satisfies GraphqlBatchResult),
    )
    await pollGithubWatches({
      db: test.db,
      emit,
      runner: theRunner,
      tokenCache: tokenCache('ghs_token'),
      fetchGraphql: third,
      log,
    })
    expect(log.info).toHaveBeenCalledWith(
      'github watch: links whose todo is done changed state, without waking their tasks',
      { count: 1 },
    )
    expect(theRunner.send).not.toHaveBeenCalled()
    expect(theRunner.queue).not.toHaveBeenCalled()
  })

  it('stops polling a link once its PR merged or its issue closed, whatever its todo says', async () => {
    const prUrl = PR_URL
    const issueUrl = 'https://github.com/acme/api/issues/7'
    addLinkArtifact(test.db, { taskId: task.id, url: prUrl, title: '#412' })
    addLinkArtifact(test.db, { taskId: task.id, url: issueUrl, title: '#7' })
    putTodos(test.db, task.id, [{ id: '1', text: 'Review #412', note: null, state: TodoState.Done, completedAt: 1 }])
    putFilings(test.db, task.id, [{ kind: ChildKind.Link, key: prUrl, todoId: '1', source: FilingSource.Named }])
    const first = vi
      .fn()
      .mockImplementation((_t: string, targets: readonly WatchTarget[]) =>
        Promise.resolve({ outcome: 'fetched', fetched: fetched(targets) } satisfies GraphqlBatchResult),
      )
    await pollGithubWatches({
      db: test.db,
      emit: vi.fn(),
      runner: runner(),
      tokenCache: tokenCache('ghs_token'),
      fetchGraphql: first,
    })

    const second = vi.fn().mockImplementation((_t: string, targets: readonly WatchTarget[]) =>
      Promise.resolve({
        outcome: 'fetched',
        fetched: new Map(
          targets.flatMap((target) => [
            ...fetched([target], {
              state: GithubLinkState.Closed,
              merged: target.kind === GithubLinkKind.PullRequest,
            }),
          ]),
        ),
      } satisfies GraphqlBatchResult),
    )
    await pollGithubWatches({
      db: test.db,
      emit: vi.fn(),
      runner: runner(),
      tokenCache: tokenCache('ghs_token'),
      fetchGraphql: second,
    })

    expect(getGithubLinkWatch(test.db, task.id, prUrl)).toMatchObject({
      state: GithubLinkState.Closed,
      merged: true,
      watching: false,
    })
    expect(getGithubLinkWatch(test.db, task.id, issueUrl)).toMatchObject({
      state: GithubLinkState.Closed,
      watching: false,
    })

    const third = vi.fn()
    await pollGithubWatches({
      db: test.db,
      emit: vi.fn(),
      runner: runner(),
      tokenCache: tokenCache('ghs_token'),
      fetchGraphql: third,
    })

    expect(third).not.toHaveBeenCalled()
  })

  it('polls a link again whose watch row was left watching=false while still open (#738)', async () => {
    addLinkArtifact(test.db, { taskId: task.id, url: PR_URL, title: '#412' })
    putGithubLinkWatch(test.db, {
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
      watching: false,
    })
    const fetchGraphql = vi
      .fn()
      .mockImplementation((_t: string, targets: readonly WatchTarget[]) =>
        Promise.resolve({ outcome: 'fetched', fetched: fetched(targets) } satisfies GraphqlBatchResult),
      )
    const emit = vi.fn<Emit>()

    await pollGithubWatches({
      db: test.db,
      emit,
      runner: runner(),
      tokenCache: tokenCache('ghs_token'),
      fetchGraphql,
    })

    expect(fetchGraphql).toHaveBeenCalledOnce()
    expect(getGithubLinkWatch(test.db, task.id, PR_URL)).toMatchObject({ watching: true })
    expect(emit).toHaveBeenCalled()
  })

  it('falls back to REST when there is no token', async () => {
    addLinkArtifact(test.db, { taskId: task.id, url: PR_URL, title: '#412' })
    const fetchRest = vi
      .fn()
      .mockImplementation((targets: readonly WatchTarget[]) =>
        Promise.resolve({ outcome: 'fetched', fetched: fetched(targets) } satisfies RestBatchResult),
      )
    const fetchGraphql = vi.fn()

    await pollGithubWatches({
      db: test.db,
      emit: vi.fn(),
      runner: runner(),
      tokenCache: tokenCache(null),
      fetchGraphql,
      fetchRest,
    })

    expect(fetchGraphql).not.toHaveBeenCalled()
    expect(fetchRest).toHaveBeenCalledOnce()
  })

  it('reads the token again on a 401, retrying once before falling back to REST', async () => {
    addLinkArtifact(test.db, { taskId: task.id, url: PR_URL, title: '#412' })
    const invalidate = vi.fn()
    let calls = 0
    const cache: GithubTokenCache = {
      get: () => Promise.resolve(calls++ === 0 ? 'ghs_old' : null),
      invalidate,
    }
    const fetchGraphql = vi.fn().mockResolvedValue({ outcome: 'unauthorized' } satisfies GraphqlBatchResult)
    const fetchRest = vi.fn().mockResolvedValue({ outcome: 'fetched', fetched: new Map() } satisfies RestBatchResult)

    await pollGithubWatches({
      db: test.db,
      emit: vi.fn(),
      runner: runner(),
      tokenCache: cache,
      fetchGraphql,
      fetchRest,
    })

    expect(fetchGraphql).toHaveBeenCalledWith('ghs_old', expect.anything())
    expect(invalidate).toHaveBeenCalledOnce()
    expect(fetchRest).toHaveBeenCalledOnce()
  })

  it('retries the GraphQL request once with a freshly read token, on a 401', async () => {
    addLinkArtifact(test.db, { taskId: task.id, url: PR_URL, title: '#412' })
    let calls = 0
    const cache: GithubTokenCache = {
      get: () => Promise.resolve(calls++ === 0 ? 'ghs_old' : 'ghs_new'),
      invalidate: vi.fn(),
    }
    const fetchGraphql = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'unauthorized' } satisfies GraphqlBatchResult)
      .mockImplementationOnce((_t: string, targets: readonly WatchTarget[]) =>
        Promise.resolve({ outcome: 'fetched', fetched: fetched(targets) } satisfies GraphqlBatchResult),
      )

    await pollGithubWatches({ db: test.db, emit: vi.fn(), runner: runner(), tokenCache: cache, fetchGraphql })

    expect(fetchGraphql).toHaveBeenCalledTimes(2)
    expect(fetchGraphql).toHaveBeenNthCalledWith(2, 'ghs_new', expect.anything())
  })

  it('backs off, writing and sending nothing, when GitHub rate-limits the request', async () => {
    addLinkArtifact(test.db, { taskId: task.id, url: PR_URL, title: '#412' })
    const fetchGraphql = vi.fn().mockResolvedValue({ outcome: 'backoff', waitMs: 90_000 } satisfies GraphqlBatchResult)
    const emit = vi.fn<Emit>()

    const waitMs = await pollGithubWatches({
      db: test.db,
      emit,
      runner: runner(),
      tokenCache: tokenCache('ghs_token'),
      fetchGraphql,
    })

    expect(waitMs).toBe(90_000)
    expect(getGithubLinkWatch(test.db, task.id, PR_URL)).toBeUndefined()
    expect(emit).not.toHaveBeenCalled()
  })

  it('leaves out a change gated off in settings', async () => {
    updateSettings(test.db, { githubWatchOnChecksFinished: false })
    addLinkArtifact(test.db, { taskId: task.id, url: PR_URL, title: '#412' })
    const first = vi
      .fn()
      .mockImplementation((_t: string, targets: readonly WatchTarget[]) =>
        Promise.resolve({ outcome: 'fetched', fetched: fetched(targets) } satisfies GraphqlBatchResult),
      )
    await pollGithubWatches({
      db: test.db,
      emit: vi.fn(),
      runner: runner(),
      tokenCache: tokenCache('ghs_token'),
      fetchGraphql: first,
    })

    const second = vi.fn().mockImplementation((_t: string, targets: readonly WatchTarget[]) =>
      Promise.resolve({
        outcome: 'fetched',
        fetched: fetched(targets, { checksState: GithubChecksState.Failure, checksSummary: '13/14' }),
      } satisfies GraphqlBatchResult),
    )
    const theRunner = runner()

    await pollGithubWatches({
      db: test.db,
      emit: vi.fn(),
      runner: theRunner,
      tokenCache: tokenCache('ghs_token'),
      fetchGraphql: second,
    })

    expect(theRunner.send).not.toHaveBeenCalled()
  })

  it('logs the source it polled with only when it changes from the last poll', async () => {
    addLinkArtifact(test.db, { taskId: task.id, url: PR_URL, title: '#412' })
    const fetchGraphql = vi
      .fn()
      .mockImplementation((_t: string, targets: readonly WatchTarget[]) =>
        Promise.resolve({ outcome: 'fetched', fetched: fetched(targets) } satisfies GraphqlBatchResult),
      )
    const fetchRest = vi
      .fn()
      .mockImplementation((targets: readonly WatchTarget[]) =>
        Promise.resolve({ outcome: 'fetched', fetched: fetched(targets) } satisfies RestBatchResult),
      )
    const log = testLog()
    const state: GithubPollState = { lastSource: null, warnedNoToken: false }
    const base = {
      db: test.db,
      emit: vi.fn<Emit>(),
      runner: runner(),
      fetchGraphql,
      fetchRest,
      log,
      state,
    }

    await pollGithubWatches({ ...base, tokenCache: tokenCache('ghs_token') })
    await pollGithubWatches({ ...base, tokenCache: tokenCache('ghs_token') })
    expect(log.info).toHaveBeenCalledExactlyOnceWith('github watch poll source', { source: 'graphql' })

    await pollGithubWatches({ ...base, tokenCache: tokenCache(null) })
    expect(log.info).toHaveBeenCalledTimes(2)
    expect(log.info).toHaveBeenLastCalledWith('github watch poll source', { source: 'rest' })
  })

  it('warns about a missing token once, not on every poll', async () => {
    addLinkArtifact(test.db, { taskId: task.id, url: PR_URL, title: '#412' })
    const fetchRest = vi
      .fn()
      .mockImplementation((targets: readonly WatchTarget[]) =>
        Promise.resolve({ outcome: 'fetched', fetched: fetched(targets) } satisfies RestBatchResult),
      )
    const log = testLog()
    const state: GithubPollState = { lastSource: null, warnedNoToken: false }
    const base = { db: test.db, emit: vi.fn<Emit>(), runner: runner(), fetchRest, log, state }

    await pollGithubWatches({ ...base, tokenCache: tokenCache(null) })
    await pollGithubWatches({ ...base, tokenCache: tokenCache(null) })

    expect(log.warn).toHaveBeenCalledExactlyOnceWith('github watch found no gh token, polling unauthenticated REST')
  })

  it('logs a backoff and how long it waits', async () => {
    addLinkArtifact(test.db, { taskId: task.id, url: PR_URL, title: '#412' })
    const fetchGraphql = vi.fn().mockResolvedValue({ outcome: 'backoff', waitMs: 90_000 } satisfies GraphqlBatchResult)
    const log = testLog()

    await pollGithubWatches({
      db: test.db,
      emit: vi.fn(),
      runner: runner(),
      tokenCache: tokenCache('ghs_token'),
      fetchGraphql,
      log,
    })

    expect(log.info).toHaveBeenCalledWith('github watch rate-limited, backing off', { waitMs: 90_000 })
  })
})
