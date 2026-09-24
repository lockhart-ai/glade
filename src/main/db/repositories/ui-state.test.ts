import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UiStateKey } from '../../../shared/domain'
import { openTestDatabase, type TestDatabase } from './test-database'
import { getUiState, listUiState, setUiState } from './ui-state'

let test: TestDatabase

beforeEach(() => {
  test = openTestDatabase()
})

afterEach(() => {
  test.close()
})

describe('UI state', () => {
  it('is undefined until set', () => {
    expect(getUiState(test.db, UiStateKey.ActiveWorkspaceId)).toBeUndefined()
  })

  it('stores a value and replaces it', () => {
    setUiState(test.db, { key: UiStateKey.ActiveWorkspaceId, value: 'workspace-1' })
    expect(getUiState(test.db, UiStateKey.ActiveWorkspaceId)).toBe('workspace-1')

    setUiState(test.db, { key: UiStateKey.ActiveWorkspaceId, value: 'workspace-2' })
    expect(getUiState(test.db, UiStateKey.ActiveWorkspaceId)).toBe('workspace-2')
  })

  it('lists every stored value, skipping keys it does not know', () => {
    expect(listUiState(test.db)).toEqual([])

    setUiState(test.db, { key: UiStateKey.SelectedTaskId, value: 'task-1' })
    setUiState(test.db, { key: UiStateKey.ActiveWorkspaceId, value: 'workspace-1' })
    test.db.prepare("INSERT INTO ui_state (key, value) VALUES ('from_the_future', 'x')").run()

    expect(listUiState(test.db)).toEqual([
      { key: UiStateKey.ActiveWorkspaceId, value: 'workspace-1' },
      { key: UiStateKey.SelectedTaskId, value: 'task-1' },
    ])
  })
})
