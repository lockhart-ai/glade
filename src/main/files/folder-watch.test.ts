import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventType, type GladeEvent } from '../../shared/bridge'
import type { WatchFolder } from '../artifacts/artifact-watch'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { createFolderWatcher, FOLDER_CHANGE_WAIT_MS, type FolderWatcher } from './folder-watch'

/** A short wait, so the tests don't sit through the real one. */
const WAIT_MS = 30

let folder: string
let root: string
let database: TestDatabase
let events: GladeEvent[]
let taskId: string
let watcher: FolderWatcher

/** The folders being watched (real paths), with what each calls back. */
let watching: Map<string, () => void>
let closed: string[]

/** Watches folders in memory: a test calls `changeIn` for what `fs.watch` would report. */
const fakeWatchFolder: WatchFolder = (watched, onChange) => {
  if (watched.endsWith('unwatchable')) throw new Error(`EPERM: ${watched}`)
  watching.set(watched, () => {
    onChange(null)
  })
  return {
    close: () => {
      watching.delete(watched)
      closed.push(watched)
    },
  }
}

function changeIn(path: string): void {
  const onChange = watching.get(path === '' ? root : join(root, path))
  if (onChange === undefined) throw new Error(`${path} isn't watched`)
  onChange()
}

/** The folders watched, relative to the root (`''` for it). */
function watched(): string[] {
  return [...watching.keys()].map((path) => (path === root ? '' : path.slice(root.length + 1))).sort()
}

function folderEvents(): { taskId: string; path: string }[] {
  return events.flatMap((event) =>
    event.type === EventType.FolderChanged ? [{ taskId: event.taskId, path: event.path }] : [],
  )
}

beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'glade-folder-watch-')))
  root = join(folder, 'acme-api')
  for (const path of ['api/tests', 'docs', 'unwatchable']) mkdirSync(join(root, path), { recursive: true })
  writeFileSync(join(root, 'README.md'), '# Acme API\n')
  mkdirSync(join(folder, 'secrets'))
  symlinkSync(join(folder, 'secrets'), join(root, 'secrets'))
  database = openTestDatabase()
  events = []
  watching = new Map()
  closed = []
  taskId = sampleTask(database.db, sampleWorkspace(database.db, root).id).id
  watcher = createFolderWatcher({
    context: { db: database.db, emit: (event) => events.push(event) },
    watchFolder: fakeWatchFolder,
    waitMs: WAIT_MS,
  })
})

afterEach(() => {
  watcher.close()
  database.close()
  rmSync(folder, { recursive: true, force: true })
})

describe('createFolderWatcher', () => {
  it('watches the folders it’s given, and no others, never one that isn’t there or leads outside the root', async () => {
    await watcher.watch(taskId, ['', 'api', 'missing', 'secrets', 'unwatchable', 'README.md'])
    // A file can be watched as fs.watch would; the tab never asks for one.
    expect(watched()).toEqual(['', 'README.md', 'api'])

    await watcher.watch(taskId, ['', 'docs'])

    expect(watched()).toEqual(['', 'docs'])
    expect(closed).toEqual([join(root, 'api'), join(root, 'README.md')])
  })

  it('tells of each changed folder once, after changes close together have settled', async () => {
    vi.useFakeTimers()
    try {
      await watcher.watch(taskId, ['', 'api', 'api/tests'])

      changeIn('api')
      changeIn('api')
      changeIn('')
      expect(folderEvents()).toEqual([])
      vi.advanceTimersByTime(WAIT_MS)
      expect(folderEvents()).toEqual([
        { taskId, path: 'api' },
        { taskId, path: '' },
      ])

      changeIn('api/tests')
      vi.advanceTimersByTime(WAIT_MS)
      expect(folderEvents().at(-1)).toEqual({ taskId, path: 'api/tests' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops watching a task on an empty list, dropping what was waiting to be told', async () => {
    vi.useFakeTimers()
    try {
      await watcher.watch(taskId, ['', 'api'])
      changeIn('api')

      await watcher.watch(taskId, [])
      vi.advanceTimersByTime(WAIT_MS)

      expect(watched()).toEqual([])
      expect(folderEvents()).toEqual([])
      // Stopping a task that isn't watched does nothing.
      await watcher.watch('another', [])
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets the latest request decide when two overlap', async () => {
    const first = watcher.watch(taskId, ['', 'api', 'docs'])
    const second = watcher.watch(taskId, ['', 'docs'])
    await Promise.all([first, second])

    expect(watched()).toEqual(['', 'docs'])
  })

  it('fails for a task that isn’t there', async () => {
    await expect(watcher.watch('gone', [''])).rejects.toThrow(/No task gone/)
  })

  it('stops everything when closed', async () => {
    vi.useFakeTimers()
    try {
      await watcher.watch(taskId, ['', 'api'])
      changeIn('api')

      watcher.close()
      vi.advanceTimersByTime(WAIT_MS)

      expect(watched()).toEqual([])
      expect(folderEvents()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits a short while by default, and watches with fs.watch', async () => {
    expect(FOLDER_CHANGE_WAIT_MS).toBe(150)
    const real = createFolderWatcher({ context: { db: database.db, emit: (event) => events.push(event) }, waitMs: 1 })
    try {
      await real.watch(taskId, ['docs'])
      // A file made each try: FSEvents can take a moment to start reporting a folder just watched.
      let made = 0
      await vi.waitFor(
        () => {
          writeFileSync(join(root, 'docs', `new-${String(made++)}.md`), '# New\n')
          expect(folderEvents()).toContainEqual({ taskId, path: 'docs' })
        },
        { timeout: 10_000, interval: 100 },
      )
    } finally {
      real.close()
    }
  })
})
