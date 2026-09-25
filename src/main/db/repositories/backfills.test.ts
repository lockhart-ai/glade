import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_HANDOFF_BYTES, type Task } from '../../../shared/domain'
import { findTaskByExternalId, getExternalId, getHandoff, setExternalId, setHandoff } from './backfills'
import { deleteTask } from './tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'

let test: TestDatabase
let task: Task
let other: Task

beforeEach(() => {
  test = openTestDatabase()
  const workspace = sampleWorkspace(test.db)
  task = sampleTask(test.db, workspace.id)
  other = sampleTask(test.db, workspace.id)
})

afterEach(() => {
  test.close()
})

describe('handoff notes', () => {
  it('has none until one is set, keeps the latest with its time, and forgets a cleared one', () => {
    expect(getHandoff(test.db, task.id)).toBeUndefined()

    expect(setHandoff(test.db, task.id, '## Where it got to', 5_000)).toEqual({
      taskId: task.id,
      body: '## Where it got to',
      addedAt: 5_000,
    })
    setHandoff(test.db, task.id, '## Next', 6_000)
    expect(getHandoff(test.db, task.id)).toEqual({ taskId: task.id, body: '## Next', addedAt: 6_000 })
    expect(getHandoff(test.db, other.id)).toBeUndefined()

    expect(setHandoff(test.db, task.id, null, 7_000)).toBeUndefined()
    expect(getHandoff(test.db, task.id)).toBeUndefined()
  })

  it('takes a note of exactly 32 KB of UTF-8 and refuses one a byte over', () => {
    const full = '€'.repeat(MAX_HANDOFF_BYTES / 4) + 'a'.repeat(MAX_HANDOFF_BYTES / 4)
    expect(Buffer.byteLength(full)).toBe(MAX_HANDOFF_BYTES)

    setHandoff(test.db, task.id, full)
    expect(getHandoff(test.db, task.id)?.body).toBe(full)
    expect(() => setHandoff(test.db, other.id, `${full}a`)).toThrow(/CHECK/)
  })

  it('keeps the external id when the note changes, and the note when the id is set', () => {
    setExternalId(test.db, task.id, 'notes/billing')
    setHandoff(test.db, task.id, 'Notes', 1)
    setHandoff(test.db, task.id, null)
    expect(getExternalId(test.db, task.id)).toBe('notes/billing')

    setHandoff(test.db, other.id, 'Other notes', 2)
    setExternalId(test.db, other.id, 'notes/other')
    expect(getHandoff(test.db, other.id)?.body).toBe('Other notes')
  })
})

describe('external ids', () => {
  it('finds the task with an id, has none for a task without one, and refuses an id another task has', () => {
    expect(getExternalId(test.db, task.id)).toBeNull()
    expect(findTaskByExternalId(test.db, 'notes/billing')).toBeUndefined()

    setExternalId(test.db, task.id, 'notes/billing')

    expect(getExternalId(test.db, task.id)).toBe('notes/billing')
    expect(findTaskByExternalId(test.db, 'notes/billing')).toBe(task.id)
    expect(() => {
      setExternalId(test.db, other.id, 'notes/billing')
    }).toThrow(/UNIQUE/)
  })

  it('goes with its task', () => {
    setExternalId(test.db, task.id, 'notes/billing')
    setHandoff(test.db, task.id, 'Notes')

    deleteTask(test.db, task.id)

    expect(findTaskByExternalId(test.db, 'notes/billing')).toBeUndefined()
    expect(getHandoff(test.db, task.id)).toBeUndefined()
  })
})
