import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventType } from '../../shared/bridge'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { emitTaskUpdated } from './handlers'

let database: TestDatabase

beforeEach(() => {
  database = openTestDatabase()
})

afterEach(() => {
  database.close()
})

it('emitTaskUpdated sends the whole task as a task.updated event', () => {
  const task = sampleTask(database.db, sampleWorkspace(database.db).id)
  const emit = vi.fn()

  emitTaskUpdated(emit, task)

  expect(emit).toHaveBeenCalledExactlyOnceWith({ type: EventType.TaskUpdated, task })
})
