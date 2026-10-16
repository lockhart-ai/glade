/**
 * Watching the files open in the Files tab (#646): a change on disk — from a shell command, a script, git, another
 * editor — says so (`files.fileChanged`), debounced, whether the file was replaced or rewritten, and stops when its
 * tab closes or its task goes. Watching the real `fs.watch` is tested once, over a real folder, for the rename and
 * delete-and-rewrite an editor or script makes; the rest uses a fake watch, as the other watchers' tests do.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventType, type GladeEvent } from '../../shared/bridge'
import type { WatchFolder } from '../artifacts/artifact-watch'
import type { Logger } from '../logging/logger'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { createFileWatcher, FILE_CHANGE_WAIT_MS, MAX_OPEN_FILE_WATCHES, type FileWatcher } from './file-watch'

/** A short wait, so the tests don't sit through the real one. */
const WAIT_MS = 30

let folder: string
let root: string
let database: TestDatabase
let events: GladeEvent[]
let taskId: string
let watcher: FileWatcher
let warnings: { message: string; fields?: Record<string, unknown> }[]

/** The folders being watched (real paths), with what each calls back. */
let watching: Map<string, (fileName: string | null) => void>
let closed: string[]

/** A logger that warns, and keeps only its warnings: what the tests read. */
const warningLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message, fields) => {
    warnings.push({ message, fields })
  },
  error: () => undefined,
  scoped: () => warningLogger,
  with: () => warningLogger,
}

/** Watches folders in memory: a test calls `changedIn` for what `fs.watch` would report. */
const fakeWatchFolder: WatchFolder = (watched, onChange) => {
  if (watched.endsWith('unwatchable')) throw new Error(`EPERM: ${watched}`)
  watching.set(watched, (fileName) => {
    onChange(fileName)
  })
  return {
    close: () => {
      watching.delete(watched)
      closed.push(watched)
    },
  }
}

/** What `fs.watch` on `folder` (relative to the root) would report: `name`, or nothing it could tell. A folder that
 * isn't watched says nothing: the tests that rely on that check `watched()` first. */
function changedIn(folder: string, name: string | null = null): void {
  watching.get(folder === '' ? root : join(root, folder))?.(name)
}

/** The folders watched, relative to the root (`''` for it). */
function watched(): string[] {
  return [...watching.keys()].map((path) => (path === root ? '' : path.slice(root.length + 1))).sort()
}

/** The files the watcher has said changed, as each's path and how many changes its watch has seen. */
function fileEvents(): { taskId: string; path: string; version: number }[] {
  return events.flatMap((event) =>
    event.type === EventType.FileChanged ? [{ taskId: event.taskId, path: event.path, version: event.version }] : [],
  )
}

/** Waits until the watcher has said of a change. */
async function afterTheWait(): Promise<void> {
  await vi.waitFor(() => {
    expect(events.length).toBeGreaterThan(0)
  })
}

/** Waits long enough for a change that must never be said of to have been said of. */
async function pastTheWait(): Promise<void> {
  await new Promise((done) => setTimeout(done, WAIT_MS * 3))
}

beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'glade-file-watch-')))
  root = join(folder, 'acme-api')
  for (const path of ['api', 'docs', 'unwatchable']) mkdirSync(join(root, path), { recursive: true })
  writeFileSync(join(root, 'docs', 'report.md'), '# Acme API\n')
  database = openTestDatabase()
  events = []
  warnings = []
  watching = new Map()
  closed = []
  taskId = sampleTask(database.db, sampleWorkspace(database.db, root).id).id
  watcher = createFileWatcher({
    context: { db: database.db, emit: (event) => events.push(event) },
    watchFolder: fakeWatchFolder,
    waitMs: WAIT_MS,
    log: warningLogger,
  })
})

afterEach(() => {
  watcher.close()
  database.close()
  rmSync(folder, { recursive: true, force: true })
})

describe('createFileWatcher', () => {
  it('watches the folder each open file is in, and says what changed, counted', async () => {
    await watcher.watch(taskId, ['docs/report.md', 'README.md'])
    expect(watched()).toEqual(['', 'docs'])

    changedIn('docs', 'report.md')
    await afterTheWait()
    expect(fileEvents()).toEqual([{ taskId, path: 'docs/report.md', version: 1 }])

    // Another change, once the wait is over, counts up.
    changedIn('docs', 'report.md')
    await vi.waitFor(() => {
      expect(fileEvents()).toHaveLength(2)
    })
    expect(fileEvents()[1]).toEqual({ taskId, path: 'docs/report.md', version: 2 })
  })

  it('tells a folder’s change by the file named, and takes a change it can’t place as any of them', async () => {
    await watcher.watch(taskId, ['docs/report.md'])
    expect(watched()).toEqual(['docs'])

    // Another file of the same folder changing isn't this file's.
    changedIn('docs', 'other.md')
    await pastTheWait()
    expect(fileEvents()).toEqual([])

    // A change the watcher can't place counts as this file's.
    changedIn('docs', null)
    await afterTheWait()
    expect(fileEvents()).toEqual([{ taskId, path: 'docs/report.md', version: 1 }])
  })

  it('says changes close together once', async () => {
    await watcher.watch(taskId, ['docs/report.md'])
    changedIn('docs', 'report.md')
    changedIn('docs', 'report.md')
    changedIn('docs', 'report.md')
    await afterTheWait()
    expect(fileEvents()).toEqual([{ taskId, path: 'docs/report.md', version: 1 }])
  })

  it('watches a file that isn’t there any more by its folder, so writing it again is noticed', async () => {
    unlinkSync(join(root, 'docs', 'report.md'))
    await watcher.watch(taskId, ['docs/report.md'])
    expect(watched()).toEqual(['docs'])

    writeFileSync(join(root, 'docs', 'report.md'), '# Acme API, again\n')
    changedIn('docs', 'report.md')
    await afterTheWait()
    expect(fileEvents()).toEqual([{ taskId, path: 'docs/report.md', version: 1 }])
  })

  it('watches nothing for a file as a commit left it', async () => {
    await watcher.watch(taskId, ['/commit/abc123/docs/report.html'])
    expect(watched()).toEqual([])
  })

  it('watches nothing for a path that leads outside the root, or a file whose folder is gone', async () => {
    await watcher.watch(taskId, ['../outside.md', 'gone/report.md'])
    expect(watched()).toEqual([])
    expect(warnings).toEqual([])
  })

  it('stops watching what a later request leaves out, keeping the folders it still wants', async () => {
    writeFileSync(join(root, 'docs', 'notes.md'), 'notes\n')
    await watcher.watch(taskId, ['docs/report.md', 'docs/notes.md', 'README.md'])
    expect(watched()).toEqual(['', 'docs'])

    await watcher.watch(taskId, ['docs/report.md'])
    expect(watched()).toEqual(['docs'])
    expect(closed).toEqual([root])

    // The folder kept is watched for the one file still open in it.
    changedIn('docs', 'notes.md')
    await pastTheWait()
    expect(fileEvents()).toEqual([])
    changedIn('docs', 'report.md')
    await afterTheWait()
    expect(fileEvents()).toEqual([{ taskId, path: 'docs/report.md', version: 1 }])
  })

  it('stops watching a task’s files when they close, and its watches drop when the task goes', async () => {
    await watcher.watch(taskId, ['docs/report.md'])
    expect(watched()).toEqual(['docs'])

    watcher.observe({ type: EventType.OpenFilesChanged, openFiles: { taskId, paths: [], activePath: null } })
    await vi.waitFor(() => {
      expect(watched()).toEqual([])
    })
    expect(closed).toEqual([join(root, 'docs')])

    changedIn('docs', 'report.md')
    await pastTheWait()
    expect(fileEvents()).toEqual([])

    await watcher.watch(taskId, ['docs/report.md'])
    watcher.observe({ type: EventType.TaskDeleted, taskId })
    expect(watched()).toEqual([])
  })

  it('watches what an event says is open, and nothing for a task that isn’t there', async () => {
    watcher.observe({
      type: EventType.OpenFilesChanged,
      openFiles: { taskId, paths: ['docs/report.md'], activePath: 'docs/report.md' },
    })
    await vi.waitFor(() => {
      expect(watched()).toEqual(['docs'])
    })

    watcher.observe({
      type: EventType.OpenFilesChanged,
      openFiles: { taskId: 't-none', paths: ['docs/report.md'], activePath: null },
    })
    await pastTheWait()
    expect(watched()).toEqual(['docs'])
    expect(warnings).toEqual([])
  })

  it('logs a folder it can’t watch, and watches the others all the same', async () => {
    writeFileSync(join(root, 'unwatchable', 'report.md'), 'report\n')
    await watcher.watch(taskId, ['docs/report.md', 'unwatchable/report.md'])
    expect(watched()).toEqual(['docs'])

    changedIn('docs', 'report.md')
    await afterTheWait()
    expect(fileEvents()).toEqual([{ taskId, path: 'docs/report.md', version: 1 }])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toContain('can’t be watched')
    expect(warnings[0]?.fields).toMatchObject({ taskId, folder: join(root, 'unwatchable') })
  })

  it(`watches at most ${String(MAX_OPEN_FILE_WATCHES)} files, and says so when it leaves some out`, async () => {
    const paths = Array.from({ length: MAX_OPEN_FILE_WATCHES + 1 }, (_, index) => `docs/report-${String(index)}.md`)
    await watcher.watch(taskId, paths)
    expect(watched()).toEqual([])
    expect(fileEvents()).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toContain('at the cap')

    // Within the cap, they're watched.
    events = []
    warnings = []
    await watcher.watch(taskId, paths.slice(0, MAX_OPEN_FILE_WATCHES))
    expect(watched()).toEqual(['docs'])
    expect(warnings).toEqual([])
  })

  it('watches nothing once closed', async () => {
    await watcher.watch(taskId, ['docs/report.md'])
    watcher.close()
    expect(watched()).toEqual([])

    changedIn('docs', 'report.md')
    await pastTheWait()
    expect(fileEvents()).toEqual([])
  })

  it(`waits ${String(FILE_CHANGE_WAIT_MS)} ms by default`, () => {
    expect(FILE_CHANGE_WAIT_MS).toBe(150)
  })
})

describe('createFileWatcher, watching for real', () => {
  // The real `fs.watch`, on a real folder, for the writes an editor or script makes: a file replaced by renaming
  // another over it (an atomic save), and one deleted and written again.
  it('says a file replaced by a rename, and one deleted and written again', async () => {
    const file = join(root, 'docs', 'report.md')
    const real = createFileWatcher({ context: { db: database.db, emit: (event) => events.push(event) }, waitMs: 50 })
    try {
      await real.watch(taskId, ['docs/report.md'])

      // An atomic save: the new text is written beside the file, then renamed over it.
      writeFileSync(join(root, 'docs', 'report.tmp.md'), '# Acme API, saved atomically\n')
      renameSync(join(root, 'docs', 'report.tmp.md'), file)
      await vi.waitFor(
        () => {
          expect(fileEvents().some(({ path }) => path === 'docs/report.md')).toBe(true)
        },
        { timeout: 5_000 },
      )

      // Deleted, then written again: the watch keeps answering.
      events = []
      unlinkSync(file)
      writeFileSync(file, '# Acme API, written again\n')
      await vi.waitFor(
        () => {
          expect(fileEvents().some(({ path }) => path === 'docs/report.md')).toBe(true)
        },
        { timeout: 5_000 },
      )
      expect(readdirSync(join(root, 'docs'))).toEqual(['report.md'])
    } finally {
      real.close()
    }
  })
})
