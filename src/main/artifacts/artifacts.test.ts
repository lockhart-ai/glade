import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BridgeErrorCode, EventType, type GladeEvent } from '../../shared/bridge'
import { ArtifactKind } from '../../shared/domain'
import { addArtifact, listArtifacts, listFileArtifacts } from '../db/repositories/artifacts'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import type { TaskServiceContext } from '../tasks/service'
import {
  addTaskArtifact,
  addTaskLinkArtifact,
  addTaskLinkByHand,
  forgetTaskArtifact,
  forgetTaskLinkArtifact,
  lookAtArtifactFile,
  refreshTaskArtifacts,
  removeTaskArtifact,
  updateTaskLinkArtifact,
} from './artifacts'

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

    const artifacts = listFileArtifacts(database.db, taskId)
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
    expect(listFileArtifacts(database.db, taskId)[0]).toMatchObject({ modifiedAt: EARLIER.getTime(), missing: true })
    await expect(refreshTaskArtifacts(context, taskId)).resolves.toBe(false)

    write('out/landing.png', 'png again', LATER)
    await expect(refreshTaskArtifacts(context, taskId)).resolves.toBe(true)
    expect(listFileArtifacts(database.db, taskId)[0]).toMatchObject({ modifiedAt: LATER.getTime(), missing: false })
  })

  it('does nothing for a task that’s gone', async () => {
    await expect(refreshTaskArtifacts(context, 'gone')).resolves.toBe(false)
    expect(events).toEqual([])
  })

  it('leaves the task’s links alone: they have no file to look at (#407)', async () => {
    addTaskLinkArtifact(context, taskId, PR, 'Navigation refresh')
    events = []

    await expect(refreshTaskArtifacts(context, taskId)).resolves.toBe(false)
    await expect(refreshTaskArtifacts(context, taskId, [PR])).resolves.toBe(false)
    expect(events).toEqual([])
  })

  it('sets the time of an artifact declared before times were kept', async () => {
    addArtifact(database.db, { taskId, path: 'notes.md', title: 'Notes' }, 1)
    write('notes.md', 'notes', LATER)

    await expect(refreshTaskArtifacts(context, taskId, ['notes.md'])).resolves.toBe(true)
    expect(listFileArtifacts(database.db, taskId).find(({ path }) => path === 'notes.md')).toMatchObject({
      modifiedAt: LATER.getTime(),
    })
  })
})

const PR = 'https://github.com/acme/api/pull/412'
const TICKET = 'https://acme.atlassian.net/browse/API-123'

/** The task's artifacts as each `artifacts.changed` carried them: `kind title`, in their order. */
function broadcasts(): string[][] {
  return events.flatMap((event) =>
    event.type === EventType.ArtifactsChanged ? [event.artifacts.map(({ kind, title }) => `${kind} ${title}`)] : [],
  )
}

describe('link artifacts (#407)', () => {
  it('are declared by a normalised URL, after the files, and renamed when declared again', async () => {
    write('docs/changelog.md', '# Changelog', EARLIER)
    await addTaskArtifact(context, taskId, 'docs/changelog.md', 'Changelog')

    const added = addTaskLinkArtifact(context, taskId, 'HTTPS://GitHub.com/acme/api/pull/412', 'Navigation refresh')
    const again = addTaskLinkArtifact(context, taskId, PR, '#412')

    expect(added).toMatchObject({ kind: ArtifactKind.Link, url: PR, title: 'Navigation refresh' })
    expect(again).toMatchObject({ url: PR, title: '#412', addedAt: added.addedAt })
    expect(broadcasts()).toEqual([
      ['file Changelog'],
      ['file Changelog', 'link Navigation refresh'],
      ['file Changelog', 'link #412'],
    ])
  })

  it('refuses, adding nothing, a URL that can’t be one, and a task that’s gone', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/hosts', 'mailto:me@example.com', 'github.com/acme']) {
      expect(() => addTaskLinkArtifact(context, taskId, url, 'Bad'), url).toThrow(/^The url /)
    }
    expect(() => addTaskLinkArtifact(context, 'gone', PR, 'PR')).toThrow(
      expect.objectContaining({ code: BridgeErrorCode.NotFound }),
    )
    expect(listArtifacts(database.db, taskId)).toEqual([])
    expect(events).toEqual([])
  })

  it('are added by hand, called what the link says or its #N, and stay as they are when added again', () => {
    expect(addTaskLinkByHand(context, taskId, { url: PR, text: PR })).toMatchObject({ title: '#412' })
    expect(addTaskLinkByHand(context, taskId, { url: TICKET, text: 'The docs refresh epic' })).toMatchObject({
      title: 'The docs refresh epic',
    })
    // The agent's title stays: a second Add to artifacts changes nothing, and broadcasts nothing.
    addTaskLinkArtifact(context, taskId, PR, 'Navigation refresh')
    events = []
    expect(addTaskLinkByHand(context, taskId, { url: PR, text: 'Something else' })).toMatchObject({
      title: 'Navigation refresh',
    })
    expect(events).toEqual([])

    expect(() => addTaskLinkByHand(context, taskId, { url: 'mailto:me@example.com', text: 'Me' })).toThrow(
      expect.objectContaining({ code: BridgeErrorCode.InvalidRequest }),
    )
    expect(() => addTaskLinkByHand(context, 'gone', { url: PR, text: PR })).toThrow(
      expect.objectContaining({ code: BridgeErrorCode.NotFound }),
    )
  })

  it('are renamed and repointed in place, by URL, and a change to nothing writes nothing', () => {
    const before = addTaskLinkArtifact(context, taskId, PR, 'PR')
    addTaskLinkArtifact(context, taskId, TICKET, 'Ticket')
    events = []

    const renamed = updateTaskLinkArtifact(context, taskId, { url: PR, title: 'Navigation refresh' })
    expect(renamed).toEqual({
      before,
      after: expect.objectContaining({ url: PR, title: 'Navigation refresh' }) as unknown,
    })
    const moved = updateTaskLinkArtifact(context, taskId, {
      url: 'https://GITHUB.com/acme/api/pull/412',
      newUrl: 'https://github.com/acme/api/pull/413',
    })
    expect(moved.after).toMatchObject({ url: 'https://github.com/acme/api/pull/413', addedAt: before.addedAt })
    expect(broadcasts()).toEqual([
      ['link Navigation refresh', 'link Ticket'],
      ['link Navigation refresh', 'link Ticket'],
    ])

    events = []
    const same = updateTaskLinkArtifact(context, taskId, { url: TICKET, title: 'Ticket', newUrl: TICKET })
    expect(same.before).toBe(same.after)
    expect(events).toEqual([])
  })

  it('refuse a change to a link that isn’t one, or onto one that is', () => {
    addTaskLinkArtifact(context, taskId, PR, 'PR')
    addTaskLinkArtifact(context, taskId, TICKET, 'Ticket')
    events = []

    expect(() => updateTaskLinkArtifact(context, taskId, { url: 'https://example.com/', title: 'X' })).toThrow(
      "https://example.com/ isn't one of this task's artifacts.",
    )
    expect(() => updateTaskLinkArtifact(context, taskId, { url: PR, newUrl: TICKET })).toThrow(
      `${TICKET} is already one of this task's artifacts ("Ticket"). Remove one of them first.`,
    )
    expect(() => updateTaskLinkArtifact(context, taskId, { url: PR, newUrl: 'javascript:alert(1)' })).toThrow(
      /^The url javascript: links/,
    )
    expect(() => updateTaskLinkArtifact(context, taskId, { url: 'nope', title: 'X' })).toThrow(/^The url nope/)
    expect(events).toEqual([])
  })

  it('are taken off by URL, and a file and a link of the same name are never mixed up', async () => {
    write('docs/changelog.md', '# Changelog', EARLIER)
    await addTaskArtifact(context, taskId, 'docs/changelog.md', 'Changelog')
    addTaskLinkArtifact(context, taskId, PR, 'PR')
    events = []

    expect(forgetTaskLinkArtifact(context, taskId, PR)).toMatchObject({ url: PR, title: 'PR' })
    expect(() => forgetTaskLinkArtifact(context, taskId, PR)).toThrow(`${PR} isn't one of this task's artifacts.`)
    // A file's path is never taken for a link's URL, or the other way about.
    expect(() => forgetTaskArtifact(context, taskId, PR)).toThrow()
    expect(() => {
      removeTaskArtifact(context, taskId, { kind: ArtifactKind.Link, url: 'docs/changelog.md' })
    }).toThrow(
      expect.objectContaining({
        code: BridgeErrorCode.NotFound,
        message: expect.stringContaining('docs/changelog.md') as unknown,
      }),
    )
    removeTaskArtifact(context, taskId, { kind: ArtifactKind.File, path: 'docs/changelog.md' })
    expect(broadcasts()).toEqual([['file Changelog'], []])
  })
})
