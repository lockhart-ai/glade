import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UiStateKey } from '../shared/domain'
import { serializeRelaunchNotice } from '../shared/relaunchNotice'
import { openTestDatabase, type TestDatabase } from './db/repositories/test-database'
import { getUiState, listUiState, setUiState } from './db/repositories/ui-state'
import { markQuit, markRunning, noteRelaunch } from './relaunch'

let test: TestDatabase

beforeEach(() => {
  test = openTestDatabase()
})

afterEach(() => {
  test.close()
})

function notice(): string | undefined {
  return getUiState(test.db, UiStateKey.RelaunchNotice)
}

describe('the running mark', () => {
  it('tells a crash from a clean quit', () => {
    // A fresh database: the app has never run.
    expect(markRunning(test.db)).toBe(false)
    // Launched again without quitting: it crashed.
    expect(markRunning(test.db)).toBe(true)

    markQuit(test.db)
    expect(markRunning(test.db)).toBe(false)
  })

  it('never reaches the windows', () => {
    markRunning(test.db)

    expect(listUiState(test.db)).toEqual([])
  })
})

describe('noteRelaunch', () => {
  it('saves the notice with the tasks that picked up after a crash', () => {
    noteRelaunch(test.db, true, ['task-1', 'task-2'])

    expect(notice()).toBe(serializeRelaunchNotice({ taskIds: ['task-1', 'task-2'] }))
  })

  it('saves nothing after a clean quit, or a crash with nothing mid-turn', () => {
    noteRelaunch(test.db, false, ['task-1'])
    noteRelaunch(test.db, true, [])

    expect(notice()).toBeUndefined()
  })

  it('keeps a notice you have not dismissed when there is nothing new to say', () => {
    noteRelaunch(test.db, true, ['task-1'])
    noteRelaunch(test.db, true, [])
    expect(notice()).toBe(serializeRelaunchNotice({ taskIds: ['task-1'] }))

    setUiState(test.db, { key: UiStateKey.RelaunchNotice, value: '' })
    noteRelaunch(test.db, false, ['task-2'])
    expect(notice()).toBe('')
  })
})
