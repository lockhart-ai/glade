// The usage-note announcements: one row per task, replacing what it said before, gone with the task.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'
import { getUsageNoteAnnouncements, saveUsageNoteAnnouncements } from './usage-note-announcements'

let database: TestDatabase
let workspaceId: string
let taskId: string

beforeEach(() => {
  database = openTestDatabase()
  workspaceId = sampleWorkspace(database.db).id
  taskId = sampleTask(database.db, workspaceId).id
})

afterEach(() => {
  database.close()
})

describe('usage-note announcements', () => {
  it('has none for a task that has never been told anything', () => {
    expect(getUsageNoteAnnouncements(database.db, taskId)).toBeUndefined()
  })

  it('stores what a task was told, replacing the row it had, and reads it back', () => {
    saveUsageNoteAnnouncements(database.db, taskId, { session: 0.41, week: null, spend: null }, 1)
    expect(getUsageNoteAnnouncements(database.db, taskId)).toEqual({ session: 0.41, week: null, spend: null })

    saveUsageNoteAnnouncements(database.db, taskId, { session: 0.52, week: 0.71, spend: 20.05 }, 2)
    expect(getUsageNoteAnnouncements(database.db, taskId)).toEqual({ session: 0.52, week: 0.71, spend: 20.05 })
  })

  it('keeps rows apart per task, and deletes one with its task', () => {
    const other = sampleTask(database.db, workspaceId).id
    saveUsageNoteAnnouncements(database.db, taskId, { session: 0.41, week: null, spend: null }, 1)
    saveUsageNoteAnnouncements(database.db, other, { session: null, week: 0.7, spend: 10 }, 2)

    expect(getUsageNoteAnnouncements(database.db, other)).toEqual({ session: null, week: 0.7, spend: 10 })

    database.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)
    expect(getUsageNoteAnnouncements(database.db, taskId)).toBeUndefined()
    expect(getUsageNoteAnnouncements(database.db, other)).toEqual({ session: null, week: 0.7, spend: 10 })
  })
})
