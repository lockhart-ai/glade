import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Artifact } from '../../../shared/domain'
import { addArtifact, listArtifacts, removeArtifact, setArtifactFile } from './artifacts'
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

    expect(notes).toEqual({
      taskId,
      path: 'docs/releases/2.4.md',
      title: 'Release notes',
      addedAt: 10,
      updatedAt: 10,
      modifiedAt: null,
      missing: false,
    })
    expect(listArtifacts(database.db, taskId).map((artifact) => artifact.path)).toEqual([
      'docs/releases/2.4.md',
      'out/email.txt',
    ])
  })

  it('take a new title when the same path is declared again, keeping their place', () => {
    addArtifact(database.db, { taskId, path: 'a.md', title: 'A' }, 10)
    addArtifact(database.db, { taskId, path: 'b.md', title: 'B' }, 20)

    const renamed = addArtifact(database.db, { taskId, path: 'a.md', title: 'A, final' }, 30)

    expect(renamed).toMatchObject({ taskId, path: 'a.md', title: 'A, final', addedAt: 10, updatedAt: 30 })
    expect(listArtifacts(database.db, taskId).map((artifact) => artifact.title)).toEqual(['A, final', 'B'])
  })

  it('are removed one at a time, and only the task’s own', () => {
    const other = sampleTask(database.db, sampleWorkspace(database.db, '/code/other').id).id
    addArtifact(database.db, { taskId, path: 'a.md', title: 'A' })
    addArtifact(database.db, { taskId, path: 'b.md', title: 'B' })
    addArtifact(database.db, { taskId: other, path: 'a.md', title: 'A' })

    expect(removeArtifact(database.db, taskId, 'a.md')).toBe(true)
    expect(removeArtifact(database.db, taskId, 'a.md')).toBe(false)

    expect(listArtifacts(database.db, taskId).map((artifact) => artifact.path)).toEqual(['b.md'])
    expect(listArtifacts(database.db, other).map((artifact) => artifact.path)).toEqual(['a.md'])
  })

  it('record when their file last changed, answering whether that changed anything', () => {
    const { db } = database
    addArtifact(db, { taskId, path: 'a.png', title: 'A' }, 10)
    const at = (): Pick<Artifact, 'modifiedAt' | 'missing'> | undefined => {
      const artifact = listArtifacts(db, taskId)[0]
      return artifact === undefined ? undefined : { modifiedAt: artifact.modifiedAt, missing: artifact.missing }
    }

    expect(setArtifactFile(db, { taskId, path: 'a.png', file: { missing: false, modifiedAt: 1_000.4 } })).toBe(true)
    expect(at()).toEqual({ modifiedAt: 1_000, missing: false })
    expect(setArtifactFile(db, { taskId, path: 'a.png', file: { missing: false, modifiedAt: 1_000 } })).toBe(false)
    expect(setArtifactFile(db, { taskId, path: 'a.png', file: { missing: false, modifiedAt: 2_000 } })).toBe(true)
    expect(at()).toEqual({ modifiedAt: 2_000, missing: false })
  })

  it('keep their last known time when their file goes, and lose "missing" when it’s back', () => {
    const { db } = database
    addArtifact(db, { taskId, path: 'a.png', title: 'A' }, 10)
    setArtifactFile(db, { taskId, path: 'a.png', file: { missing: false, modifiedAt: 2_000 } })

    expect(setArtifactFile(db, { taskId, path: 'a.png', file: { missing: true } })).toBe(true)
    expect(setArtifactFile(db, { taskId, path: 'a.png', file: { missing: true } })).toBe(false)
    expect(listArtifacts(db, taskId)[0]).toMatchObject({ modifiedAt: 2_000, missing: true })
    // Back as it was, it's no longer missing.
    expect(setArtifactFile(db, { taskId, path: 'a.png', file: { missing: false, modifiedAt: 2_000 } })).toBe(true)
    expect(listArtifacts(db, taskId)[0]).toMatchObject({ modifiedAt: 2_000, missing: false })
    // Declared again, it keeps what was seen of its file.
    addArtifact(db, { taskId, path: 'a.png', title: 'A, final' }, 30)
    expect(listArtifacts(db, taskId)[0]).toMatchObject({ title: 'A, final', modifiedAt: 2_000, missing: false })
    // One it doesn't have changes nothing.
    expect(setArtifactFile(db, { taskId, path: 'b.png', file: { missing: true } })).toBe(false)
  })

  it('are each task’s own', () => {
    const other = sampleTask(database.db, sampleWorkspace(database.db, '/code/other').id).id
    addArtifact(database.db, { taskId, path: 'a.md', title: 'A' })

    expect(listArtifacts(database.db, other)).toEqual([])
  })
})
