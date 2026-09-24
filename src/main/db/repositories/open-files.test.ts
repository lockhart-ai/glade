import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getOpenFiles, setOpenFiles } from './open-files'
import { RowError } from './rows'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'

let database: TestDatabase
let taskId: string

beforeEach(() => {
  database = openTestDatabase()
  taskId = sampleTask(database.db, sampleWorkspace(database.db).id).id
})

afterEach(() => {
  database.close()
})

describe('open files', () => {
  it('are none until set, then as last set', () => {
    expect(getOpenFiles(database.db, taskId)).toEqual({ taskId, paths: [], activePath: null })

    setOpenFiles(database.db, {
      taskId,
      paths: ['docs/rate-limits.md', 'api/throttles.py'],
      activePath: 'api/throttles.py',
    })
    setOpenFiles(database.db, { taskId, paths: ['docs/rate-limits.md'], activePath: 'docs/rate-limits.md' })

    expect(getOpenFiles(database.db, taskId)).toEqual({
      taskId,
      paths: ['docs/rate-limits.md'],
      activePath: 'docs/rate-limits.md',
    })
  })

  it('show no tab when the stored one showing is not open', () => {
    database.db.prepare("INSERT INTO open_files VALUES (?, '[\"README.md\"]', 'gone.md')").run(taskId)

    expect(getOpenFiles(database.db, taskId).activePath).toBeNull()
  })

  it('refuse paths that are not all strings', () => {
    database.db.prepare("INSERT INTO open_files VALUES (?, '[1]', NULL)").run(taskId)

    expect(() => getOpenFiles(database.db, taskId)).toThrow(RowError)
  })
})
