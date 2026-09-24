import { afterEach, beforeEach, expect, it } from 'vitest'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'
import { clearWorkspaceSelection, getWorkspaceSelection, setWorkspaceSelection } from './workspace-selections'

let database: TestDatabase

beforeEach(() => {
  database = openTestDatabase()
})

afterEach(() => {
  database.close()
})

it('records, replaces and clears the task selected in each workspace', () => {
  const { db } = database
  const acme = sampleWorkspace(db)
  const web = sampleWorkspace(db, '/code/acme-web')
  const first = sampleTask(db, acme.id)
  const second = sampleTask(db, acme.id)
  const other = sampleTask(db, web.id)

  expect(getWorkspaceSelection(db, acme.id)).toBeUndefined()
  setWorkspaceSelection(db, acme.id, first.id)
  setWorkspaceSelection(db, web.id, other.id)
  setWorkspaceSelection(db, acme.id, second.id)
  expect(getWorkspaceSelection(db, acme.id)).toBe(second.id)
  expect(getWorkspaceSelection(db, web.id)).toBe(other.id)

  clearWorkspaceSelection(db, acme.id)
  expect(getWorkspaceSelection(db, acme.id)).toBeUndefined()
  expect(getWorkspaceSelection(db, web.id)).toBe(other.id)
})
