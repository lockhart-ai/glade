import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventType, type GladeEvent } from '../../shared/bridge'
import { addArtifact, listArtifacts } from '../db/repositories/artifacts'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import type { TaskServiceContext } from '../tasks/service'
import { addTaskArtifact, lookAtArtifactFile, refreshTaskArtifacts } from './artifacts'

let folder: string
let root: string
let database: TestDatabase
let events: GladeEvent[]
let context: TaskServiceContext
let taskId: string

const EARLIER = new Date(1_700_000_000_000)
const LATER = new Date(1_700_000_600_000)

function write(path: string, content = 'content', at: Date = EARLIER): void {
  const full = join(root, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
  utimesSync(full, at, at)
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'glade-artifacts-'))
  root = join(folder, 'acme-docs')
  mkdirSync(root)
  database = openTestDatabase()
  events = []
  context = { db: database.db, emit: (event) => events.push(event) }
  taskId = sampleTask(database.db, sampleWorkspace(database.db, root).id).id
})

afterEach(() => {
  database.close()
  rmSync(folder, { recursive: true, force: true })
})

describe('lookAtArtifactFile', () => {
  it('says when a file last changed', async () => {
    write('out/landing.png', 'png', LATER)
    await expect(lookAtArtifactFile(root, 'out/landing.png')).resolves.toEqual({
      missing: false,
      modifiedAt: LATER.getTime(),
    })
  })

  it('finds a file gone when there’s nothing there, a folder, a path outside, or no workspace at all', async () => {
    mkdirSync(join(root, 'out'))
    writeFileSync(join(folder, 'secret.txt'), 'hunter2')
    symlinkSync(join(folder, 'secret.txt'), join(root, 'secret.txt'))

    for (const path of ['gone.md', 'out', 'secret.txt']) {
      await expect(lookAtArtifactFile(root, path), path).resolves.toEqual({ missing: true })
    }
    await expect(lookAtArtifactFile(join(folder, 'no-such-root'), 'a.md')).resolves.toEqual({ missing: true })
  })
})

describe('addTaskArtifact', () => {
  it('notes when the declared file last changed, and broadcasts the list with it', async () => {
    write('docs/changelog.md', '# Changelog', EARLIER)

    const added = await addTaskArtifact(context, taskId, join(root, 'docs/changelog.md'), 'Changelog')

    expect(added).toMatchObject({ path: 'docs/changelog.md', modifiedAt: EARLIER.getTime(), missing: false })
    expect(events).toEqual([{ type: EventType.ArtifactsChanged, taskId, artifacts: [added] }])
  })

  it('notes the new time when the file is declared again after it changed, taking the new title', async () => {
    write('docs/changelog.md', '# Changelog', EARLIER)
    await addTaskArtifact(context, taskId, 'docs/changelog.md', 'Changelog')
    write('docs/changelog.md', '# Changelog 2.4', LATER)

    const again = await addTaskArtifact(context, taskId, 'docs/changelog.md', 'Changelog, final')

    expect(again).toMatchObject({ title: 'Changelog, final', modifiedAt: LATER.getTime() })
  })
})

describe('refreshTaskArtifacts', () => {
  beforeEach(async () => {
    write('out/landing.png', 'png', EARLIER)
    write('docs/changelog.md', '# Changelog', EARLIER)
    await addTaskArtifact(context, taskId, 'out/landing.png', 'Landing page')
    await addTaskArtifact(context, taskId, 'docs/changelog.md', 'Changelog')
    events = []
  })

  it('changes nothing, and broadcasts nothing, while the files are as they were', async () => {
    await expect(refreshTaskArtifacts(context, taskId)).resolves.toBe(false)
    expect(events).toEqual([])
  })

  it('notes a file edited since, and broadcasts the list with its new time', async () => {
    write('docs/changelog.md', '# Changelog 2.4', LATER)

    await expect(refreshTaskArtifacts(context, taskId)).resolves.toBe(true)

    const artifacts = listArtifacts(database.db, taskId)
    expect(artifacts.map(({ path, modifiedAt }) => [path, modifiedAt])).toEqual([
      ['out/landing.png', EARLIER.getTime()],
      ['docs/changelog.md', LATER.getTime()],
    ])
    expect(events).toEqual([{ type: EventType.ArtifactsChanged, taskId, artifacts }])
  })

  it('looks only at the files it’s asked about', async () => {
    write('docs/changelog.md', '# Changelog 2.4', LATER)

    await expect(refreshTaskArtifacts(context, taskId, ['out/landing.png'])).resolves.toBe(false)
    await expect(refreshTaskArtifacts(context, taskId, ['docs/changelog.md'])).resolves.toBe(true)
  })

  it('keeps a deleted file at its last known time, as missing, and finds it again when it’s back', async () => {
    unlinkSync(join(root, 'out', 'landing.png'))

    await expect(refreshTaskArtifacts(context, taskId)).resolves.toBe(true)
    expect(listArtifacts(database.db, taskId)[0]).toMatchObject({ modifiedAt: EARLIER.getTime(), missing: true })
    await expect(refreshTaskArtifacts(context, taskId)).resolves.toBe(false)

    write('out/landing.png', 'png again', LATER)
    await expect(refreshTaskArtifacts(context, taskId)).resolves.toBe(true)
    expect(listArtifacts(database.db, taskId)[0]).toMatchObject({ modifiedAt: LATER.getTime(), missing: false })
  })

  it('does nothing for a task that’s gone', async () => {
    await expect(refreshTaskArtifacts(context, 'gone')).resolves.toBe(false)
    expect(events).toEqual([])
  })

  it('sets the time of an artifact declared before times were kept', async () => {
    addArtifact(database.db, { taskId, path: 'notes.md', title: 'Notes' }, 1)
    write('notes.md', 'notes', LATER)

    await expect(refreshTaskArtifacts(context, taskId, ['notes.md'])).resolves.toBe(true)
    expect(listArtifacts(database.db, taskId).find(({ path }) => path === 'notes.md')).toMatchObject({
      modifiedAt: LATER.getTime(),
    })
  })
})
