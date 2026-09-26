import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Effort, WatcherKind, WatcherState, type Task } from '../../../shared/domain'
import { createTask } from './tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'
import {
  addWatcher,
  findWatcherBySdkId,
  getWatcher,
  listLiveWatchers,
  listWatchers,
  publicWatcher,
  updateWatcher,
  type NewWatcher,
} from './watchers'

let test: TestDatabase
let task: Task

beforeEach(() => {
  test = openTestDatabase()
  task = sampleTask(test.db, sampleWorkspace(test.db).id)
})

afterEach(() => {
  test.close()
})

function monitor(toolUseId: string, taskId = task.id): NewWatcher {
  return {
    taskId,
    kind: WatcherKind.Monitor,
    toolUseId,
    sdkId: `b-${toolUseId}`,
    label: 'CI checks on PR #42',
    detail: 'gh pr checks 42 --watch',
    cron: null,
    schedule: null,
    recurring: true,
    state: WatcherState.Running,
    nextDueAt: null,
    expiresAt: 9_000,
  }
}

describe('watchers', () => {
  it('adds one per tool call, and adding it again answers with the one there is', () => {
    const added = addWatcher(test.db, monitor('toolu_1'), 5_000)
    expect(added).toEqual({
      id: expect.any(String) as unknown,
      taskId: task.id,
      kind: WatcherKind.Monitor,
      toolUseId: 'toolu_1',
      sdkId: 'b-toolu_1',
      label: 'CI checks on PR #42',
      detail: 'gh pr checks 42 --watch',
      cron: null,
      schedule: null,
      recurring: true,
      state: WatcherState.Running,
      wakes: 0,
      lastWokeAt: null,
      lastOutput: null,
      nextDueAt: null,
      expiresAt: 9_000,
      outcome: null,
      stoppedByYou: false,
      startedAt: 5_000,
      endedAt: null,
    })
    expect(addWatcher(test.db, { ...monitor('toolu_1'), label: 'Other' }, 6_000)).toEqual(added)
    expect(listWatchers(test.db, task.id)).toEqual([added])
    expect(getWatcher(test.db, added.id)).toEqual(added)
    expect(getWatcher(test.db, 'nope')).toBeUndefined()
  })

  it('changes only what it is given, and answers with the watcher as it now is', () => {
    const { id } = addWatcher(test.db, monitor('toolu_1'), 5_000)
    const changed = updateWatcher(test.db, id, {
      sdkId: 'b-new',
      state: WatcherState.Stopped,
      wakes: 3,
      lastWokeAt: 6_000,
      lastOutput: 'unit-tests fail',
      nextDueAt: null,
      expiresAt: null,
      outcome: 'You stopped it.',
      stoppedByYou: true,
      endedAt: 7_000,
    })
    expect(changed).toMatchObject({
      sdkId: 'b-new',
      state: WatcherState.Stopped,
      wakes: 3,
      lastWokeAt: 6_000,
      lastOutput: 'unit-tests fail',
      expiresAt: null,
      outcome: 'You stopped it.',
      stoppedByYou: true,
      endedAt: 7_000,
      label: 'CI checks on PR #42',
    })
    expect(updateWatcher(test.db, id, {})).toEqual(changed)
    expect(updateWatcher(test.db, 'nope', { wakes: 1 })).toBeUndefined()
  })

  it('lists every task’s live ones, and finds a task’s by the SDK’s id and kind', () => {
    const other = createTask(test.db, { workspaceId: task.workspaceId, model: 'm', effort: Effort.Low })
    const running = addWatcher(test.db, monitor('toolu_1'), 1_000)
    const ended = addWatcher(test.db, monitor('toolu_2'), 2_000)
    updateWatcher(test.db, ended.id, { state: WatcherState.Finished })
    const suspended = addWatcher(
      test.db,
      { ...monitor('toolu_3', other.id), kind: WatcherKind.Cron, state: WatcherState.Suspended, sdkId: 'c1' },
      3_000,
    )
    const scheduled = addWatcher(
      test.db,
      { ...monitor('toolu_4', other.id), kind: WatcherKind.Wakeup, state: WatcherState.Scheduled, sdkId: null },
      4_000,
    )

    expect(listLiveWatchers(test.db).map(({ id }) => id)).toEqual([running.id, suspended.id, scheduled.id])
    expect(findWatcherBySdkId(test.db, task.id, 'b-toolu_1', [WatcherKind.Monitor])?.id).toBe(running.id)
    expect(findWatcherBySdkId(test.db, task.id, 'b-toolu_1', [WatcherKind.Cron])).toBeUndefined()
    expect(findWatcherBySdkId(test.db, other.id, 'b-toolu_1', [WatcherKind.Monitor])).toBeUndefined()
  })

  it('shows the windows a watcher without what only matching the SDK needs', () => {
    const stored = addWatcher(test.db, { ...monitor('toolu_1'), cron: '* * * * *' }, 1_000)
    const shown = publicWatcher(stored)
    expect(shown).not.toHaveProperty('sdkId')
    expect(shown).not.toHaveProperty('cron')
    expect(shown).not.toHaveProperty('stoppedByYou')
    expect({ ...shown, sdkId: stored.sdkId, cron: stored.cron, stoppedByYou: stored.stoppedByYou }).toEqual(stored)
  })
})
