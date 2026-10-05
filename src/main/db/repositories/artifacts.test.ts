import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArtifactKind, type ArtifactRef, type FileArtifact } from '../../../shared/domain'
import {
  addArtifact,
  addLinkArtifact,
  changeArtifact,
  changeLinkArtifact,
  getArtifact,
  listArtifacts,
  listFileArtifacts,
  removeArtifact,
  setArtifactFile,
} from './artifacts'
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

/** A file artifact's ref, by its path. */
function file(path: string): ArtifactRef {
  return { kind: ArtifactKind.File, path }
}

/** A link artifact's ref, by its URL. */
function link(url: string): ArtifactRef {
  return { kind: ArtifactKind.Link, url }
}

describe('artifacts', () => {
  it('are none until declared, then listed in the order first declared', () => {
    expect(listFileArtifacts(database.db, taskId)).toEqual([])

    const notes = addArtifact(database.db, { taskId, path: 'docs/releases/2.4.md', title: 'Release notes' }, 10)
    addArtifact(database.db, { taskId, path: 'out/email.txt', title: 'Email' }, 10)

    expect(notes).toEqual({
      kind: ArtifactKind.File,
      taskId,
      path: 'docs/releases/2.4.md',
      title: 'Release notes',
      addedAt: 10,
      updatedAt: 10,
      modifiedAt: null,
      missing: false,
    })
    expect(listFileArtifacts(database.db, taskId).map((artifact) => artifact.path)).toEqual([
      'docs/releases/2.4.md',
      'out/email.txt',
    ])
  })

  it('take a new title when the same path is declared again, keeping their place', () => {
    addArtifact(database.db, { taskId, path: 'a.md', title: 'A' }, 10)
    addArtifact(database.db, { taskId, path: 'b.md', title: 'B' }, 20)

    const renamed = addArtifact(database.db, { taskId, path: 'a.md', title: 'A, final' }, 30)

    expect(renamed).toMatchObject({ taskId, path: 'a.md', title: 'A, final', addedAt: 10, updatedAt: 30 })
    expect(listFileArtifacts(database.db, taskId).map((artifact) => artifact.title)).toEqual(['A, final', 'B'])
  })

  it('are found by path, and changed in place: a new file, a new title, keeping their place and what was seen', () => {
    const other = sampleTask(database.db, sampleWorkspace(database.db, '/code/other').id).id
    addArtifact(database.db, { taskId, path: 'a.md', title: 'A' }, 10)
    addArtifact(database.db, { taskId, path: 'b.md', title: 'B' }, 20)
    addArtifact(database.db, { taskId: other, path: 'a.md', title: 'Other A' }, 20)
    setArtifactFile(database.db, { taskId, path: 'a.md', file: { missing: true } })

    expect(getArtifact(database.db, taskId, file('a.md'))).toMatchObject({ title: 'A', missing: true })
    expect(getArtifact(database.db, taskId, file('c.md'))).toBeUndefined()

    const moved = changeArtifact(database.db, { taskId, path: 'a.md', newPath: 'docs/a.md', title: 'A, moved' }, 30)

    expect(moved).toEqual({
      kind: ArtifactKind.File,
      taskId,
      path: 'docs/a.md',
      title: 'A, moved',
      addedAt: 10,
      updatedAt: 30,
      modifiedAt: null,
      missing: true,
    })
    expect(listFileArtifacts(database.db, taskId).map(({ path }) => path)).toEqual(['docs/a.md', 'b.md'])
    expect(getArtifact(database.db, taskId, file('a.md'))).toBeUndefined()
    expect(getArtifact(database.db, other, file('a.md'))).toMatchObject({ title: 'Other A' })
    expect(changeArtifact(database.db, { taskId, path: 'a.md', newPath: 'z.md', title: 'Z' })).toBeUndefined()
  })

  it('are removed one at a time, and only the task’s own', () => {
    const other = sampleTask(database.db, sampleWorkspace(database.db, '/code/other').id).id
    addArtifact(database.db, { taskId, path: 'a.md', title: 'A' })
    addArtifact(database.db, { taskId, path: 'b.md', title: 'B' })
    addArtifact(database.db, { taskId: other, path: 'a.md', title: 'A' })

    expect(removeArtifact(database.db, taskId, file('a.md'))).toBe(true)
    expect(removeArtifact(database.db, taskId, file('a.md'))).toBe(false)

    expect(listFileArtifacts(database.db, taskId).map((artifact) => artifact.path)).toEqual(['b.md'])
    expect(listFileArtifacts(database.db, other).map((artifact) => artifact.path)).toEqual(['a.md'])
  })

  it('record when their file last changed, answering whether that changed anything', () => {
    const { db } = database
    addArtifact(db, { taskId, path: 'a.png', title: 'A' }, 10)
    const at = (): Pick<FileArtifact, 'modifiedAt' | 'missing'> | undefined => {
      const artifact = listFileArtifacts(db, taskId)[0]
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
    expect(listFileArtifacts(db, taskId)[0]).toMatchObject({ modifiedAt: 2_000, missing: true })
    // Back as it was, it's no longer missing.
    expect(setArtifactFile(db, { taskId, path: 'a.png', file: { missing: false, modifiedAt: 2_000 } })).toBe(true)
    expect(listFileArtifacts(db, taskId)[0]).toMatchObject({ modifiedAt: 2_000, missing: false })
    // Declared again, it keeps what was seen of its file.
    addArtifact(db, { taskId, path: 'a.png', title: 'A, final' }, 30)
    expect(listFileArtifacts(db, taskId)[0]).toMatchObject({ title: 'A, final', modifiedAt: 2_000, missing: false })
    // One it doesn't have changes nothing.
    expect(setArtifactFile(db, { taskId, path: 'b.png', file: { missing: true } })).toBe(false)
  })

  it('are each task’s own', () => {
    const other = sampleTask(database.db, sampleWorkspace(database.db, '/code/other').id).id
    addArtifact(database.db, { taskId, path: 'a.md', title: 'A' })

    expect(listFileArtifacts(database.db, other)).toEqual([])
  })
})

describe('link artifacts (#407)', () => {
  const PR = 'https://github.com/acme/api/pull/412'
  const TICKET = 'https://acme.atlassian.net/browse/API-123'

  it('are declared by URL, listed among the files in the order first declared, and renamed when declared again', () => {
    const { db } = database
    addArtifact(db, { taskId, path: 'docs/notes.md', title: 'Notes' }, 10)
    const pr = addLinkArtifact(db, { taskId, url: PR, title: 'Navigation refresh' }, 20)
    addArtifact(db, { taskId, path: 'out/email.txt', title: 'Email' }, 30)

    expect(pr).toEqual({
      kind: ArtifactKind.Link,
      taskId,
      url: PR,
      title: 'Navigation refresh',
      addedAt: 20,
      updatedAt: 20,
    })
    expect(addLinkArtifact(db, { taskId, url: PR, title: '#412' }, 40)).toMatchObject({ addedAt: 20, updatedAt: 40 })
    expect(listArtifacts(db, taskId).map(({ kind, title }) => [kind, title])).toEqual([
      [ArtifactKind.File, 'Notes'],
      [ArtifactKind.Link, '#412'],
      [ArtifactKind.File, 'Email'],
    ])
    expect(listFileArtifacts(db, taskId).map(({ path }) => path)).toEqual(['docs/notes.md', 'out/email.txt'])
  })

  it('are found, changed and removed by URL, never taken for a file, and only the task’s own', () => {
    const { db } = database
    const other = sampleTask(db, sampleWorkspace(db, '/code/other').id).id
    addLinkArtifact(db, { taskId, url: PR, title: 'PR' }, 10)
    addLinkArtifact(db, { taskId: other, url: PR, title: 'Their PR' }, 10)
    // A file whose path reads like the URL is another artifact altogether.
    addArtifact(db, { taskId, path: PR, title: 'Odd file' }, 10)

    expect(getArtifact(db, taskId, link(PR))).toMatchObject({ kind: ArtifactKind.Link, title: 'PR' })
    expect(getArtifact(db, taskId, file(PR))).toMatchObject({ kind: ArtifactKind.File, title: 'Odd file' })
    expect(getArtifact(db, taskId, link(TICKET))).toBeUndefined()

    expect(changeLinkArtifact(db, { taskId, url: PR, newUrl: TICKET, title: 'Ticket' }, 20)).toEqual({
      kind: ArtifactKind.Link,
      taskId,
      url: TICKET,
      title: 'Ticket',
      addedAt: 10,
      updatedAt: 20,
    })
    expect(changeLinkArtifact(db, { taskId, url: PR, newUrl: TICKET, title: 'Gone' })).toBeUndefined()
    // A file's change never touches a link, nor a link's a file.
    expect(changeArtifact(db, { taskId, path: TICKET, newPath: 'x.md', title: 'X' })).toBeUndefined()
    expect(changeLinkArtifact(db, { taskId, url: PR, newUrl: 'https://example.com/', title: 'X' })).toBeUndefined()

    expect(removeArtifact(db, taskId, link(TICKET))).toBe(true)
    expect(removeArtifact(db, taskId, link(TICKET))).toBe(false)
    expect(listArtifacts(db, taskId).map(({ title }) => title)).toEqual(['Odd file'])
    expect(listArtifacts(db, other).map(({ title }) => title)).toEqual(['Their PR'])
  })

  it('have no file to look at: what was seen of a file never reaches one', () => {
    const { db } = database
    addLinkArtifact(db, { taskId, url: PR, title: 'PR' }, 10)

    expect(setArtifactFile(db, { taskId, path: PR, file: { missing: true } })).toBe(false)
    expect(listArtifacts(db, taskId)).toEqual([
      { kind: ArtifactKind.Link, taskId, url: PR, title: 'PR', addedAt: 10, updatedAt: 10 },
    ])
  })

  it('can’t be stored half a file and half a link', () => {
    const { db } = database
    const insert = (kind: string, path: string | null, url: string | null): unknown =>
      db
        .prepare(
          'INSERT INTO artifacts (task_id, kind, path, url, title, added_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)',
        )
        .run(taskId, kind, path, url, 'Bad')

    expect(() => insert('link', 'a.md', PR)).toThrow(/CHECK/)
    expect(() => insert('file', null, PR)).toThrow(/CHECK/)
    expect(() => insert('link', null, null)).toThrow(/CHECK/)
    expect(() => insert('page', null, PR)).toThrow(/CHECK/)
    insert('link', null, PR)
    expect(() => insert('link', null, PR)).toThrow(/UNIQUE/)
    expect(() => db.prepare('UPDATE artifacts SET missing = 1 WHERE url = ?').run(PR)).toThrow(/CHECK/)
  })
})
