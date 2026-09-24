import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UiStateKey } from '../../../shared/domain'
import { openTestDatabase, type TestDatabase } from './test-database'
import { getUiState, setUiState } from './ui-state'

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
})
