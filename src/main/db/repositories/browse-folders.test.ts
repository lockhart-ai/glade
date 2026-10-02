import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listBrowseFolders, setBrowseFolderExpanded } from './browse-folders'
import { deleteTask } from './tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'

let database: TestDatabase
let taskId: string
let otherId: string

beforeEach(() => {
  database = openTestDatabase()
  const workspaceId = sampleWorkspace(database.db).id
  taskId = sampleTask(database.db, workspaceId).id
  otherId = sampleTask(database.db, workspaceId).id
})

afterEach(() => {
  database.close()
})

describe('the Browse tab’s open folders', () => {
  it('are none until one is opened', () => {
    expect(listBrowseFolders(database.db, taskId)).toEqual([])
  })

  it('remember each folder opened, by path, until it’s closed, for their own task only', () => {
    const { db } = database
    setBrowseFolderExpanded(db, { taskId, path: 'docs', expanded: true })
    setBrowseFolderExpanded(db, { taskId, path: 'api/tests', expanded: true })
    setBrowseFolderExpanded(db, { taskId, path: 'api', expanded: true })
    // Opening one twice keeps one row; closing one that isn't open does nothing.
    setBrowseFolderExpanded(db, { taskId, path: 'api', expanded: true })
    setBrowseFolderExpanded(db, { taskId, path: 'config', expanded: false })
    setBrowseFolderExpanded(db, { taskId: otherId, path: 'scripts', expanded: true })

    expect(listBrowseFolders(db, taskId)).toEqual(['api', 'api/tests', 'docs'])

    setBrowseFolderExpanded(db, { taskId, path: 'api', expanded: false })

    expect(listBrowseFolders(db, taskId)).toEqual(['api/tests', 'docs'])
    expect(listBrowseFolders(db, otherId)).toEqual(['scripts'])
  })

  it('go with their task', () => {
    const { db } = database
    setBrowseFolderExpanded(db, { taskId, path: 'docs', expanded: true })

    deleteTask(db, taskId)

    expect(listBrowseFolders(db, taskId)).toEqual([])
  })
})
