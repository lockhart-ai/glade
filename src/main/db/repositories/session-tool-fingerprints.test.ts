import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Task } from '../../../shared/domain'
import { getToolFingerprints, setToolFingerprints } from './session-tool-fingerprints'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'

let test: TestDatabase
let task: Task

beforeEach(() => {
  test = openTestDatabase()
  task = sampleTask(test.db, sampleWorkspace(test.db).id)
})

afterEach(() => {
  test.close()
})

it('is empty for a task with nothing recorded', () => {
  expect(getToolFingerprints(test.db, task.id)).toEqual(new Map())
})

it('records a fingerprint per tool, read back by name', () => {
  setToolFingerprints(
    test.db,
    task.id,
    new Map([
      ['update_todo', 'abc'],
      ['create_todo', 'def'],
    ]),
  )

  expect(getToolFingerprints(test.db, task.id)).toEqual(
    new Map([
      ['update_todo', 'abc'],
      ['create_todo', 'def'],
    ]),
  )
})

it('overwrites a tool already recorded, and leaves the others as they were', () => {
  setToolFingerprints(
    test.db,
    task.id,
    new Map([
      ['update_todo', 'abc'],
      ['create_todo', 'def'],
    ]),
  )

  setToolFingerprints(test.db, task.id, new Map([['update_todo', 'xyz']]))

  expect(getToolFingerprints(test.db, task.id)).toEqual(
    new Map([
      ['update_todo', 'xyz'],
      ['create_todo', 'def'],
    ]),
  )
})

it("keeps each task's own, apart from another's", () => {
  const other = sampleTask(test.db, task.workspaceId)

  setToolFingerprints(test.db, task.id, new Map([['update_todo', 'abc']]))
  setToolFingerprints(test.db, other.id, new Map([['update_todo', 'different']]))

  expect(getToolFingerprints(test.db, task.id)).toEqual(new Map([['update_todo', 'abc']]))
  expect(getToolFingerprints(test.db, other.id)).toEqual(new Map([['update_todo', 'different']]))
})
