import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addArtifact, listArtifacts } from './artifacts'
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

describe('artifacts', () => {
  it('are none until declared, then listed in the order first declared', () => {
    expect(listArtifacts(database.db, taskId)).toEqual([])

    const notes = addArtifact(database.db, { taskId, path: 'docs/releases/2.4.md', title: 'Release notes' }, 10)
    addArtifact(database.db, { taskId, path: 'out/email.txt', title: 'Email' }, 10)

    expect(notes).toEqual({ taskId, path: 'docs/releases/2.4.md', title: 'Release notes', addedAt: 10, updatedAt: 10 })
    expect(listArtifacts(database.db, taskId).map((artifact) => artifact.path)).toEqual([
      'docs/releases/2.4.md',
      'out/email.txt',
    ])
  })

  it('take a new title when the same path is declared again, keeping their place', () => {
    addArtifact(database.db, { taskId, path: 'a.md', title: 'A' }, 10)
    addArtifact(database.db, { taskId, path: 'b.md', title: 'B' }, 20)

    const renamed = addArtifact(database.db, { taskId, path: 'a.md', title: 'A, final' }, 30)

    expect(renamed).toEqual({ taskId, path: 'a.md', title: 'A, final', addedAt: 10, updatedAt: 30 })
    expect(listArtifacts(database.db, taskId).map((artifact) => artifact.title)).toEqual(['A, final', 'B'])
  })

  it('are each task’s own', () => {
    const other = sampleTask(database.db, sampleWorkspace(database.db, '/code/other').id).id
    addArtifact(database.db, { taskId, path: 'a.md', title: 'A' })

    expect(listArtifacts(database.db, other)).toEqual([])
  })
})
