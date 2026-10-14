import { afterEach, beforeEach, expect, it } from 'vitest'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'
import { getStoppedWorkNote, setStoppedWorkNote } from './stopped-work-notes'

let test: TestDatabase
let taskId: string

beforeEach(() => {
  test = openTestDatabase()
  taskId = sampleTask(test.db, sampleWorkspace(test.db).id).id
})

afterEach(() => {
  test.close()
})

it('answers null for a task with no note', () => {
  expect(getStoppedWorkNote(test.db, taskId)).toBeNull()
})

it('stores a note and reads it back', () => {
  setStoppedWorkNote(test.db, taskId, 'Glade stopped the background work.')
  expect(getStoppedWorkNote(test.db, taskId)).toBe('Glade stopped the background work.')
})

it('replaces the note a task had', () => {
  setStoppedWorkNote(test.db, taskId, 'First switch.')
  setStoppedWorkNote(test.db, taskId, 'Second switch.')
  expect(getStoppedWorkNote(test.db, taskId)).toBe('Second switch.')
  expect(test.db.prepare('SELECT COUNT(*) FROM stopped_work_notes WHERE task_id = ?').pluck().get(taskId)).toBe(1)
})

it('removes the note when cleared, and clearing a task without one does nothing', () => {
  setStoppedWorkNote(test.db, taskId, 'Glade stopped the background work.')
  setStoppedWorkNote(test.db, taskId, null)
  expect(getStoppedWorkNote(test.db, taskId)).toBeNull()
  expect(() => {
    setStoppedWorkNote(test.db, taskId, null)
  }).not.toThrow()
})
