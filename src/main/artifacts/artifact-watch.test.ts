import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventType, type ArtifactsChangedEvent, type GladeEvent } from '../../shared/bridge'
import {
  ToolCallState,
  ToolEventKind,
  type Artifact,
  type EpochMs,
  type ToolCallEvent,
  type ToolInput,
} from '../../shared/domain'
import { addArtifact, listArtifacts } from '../db/repositories/artifacts'
import { deleteTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import {
  ARTIFACT_CHANGE_WAIT_MS,
  createArtifactWatcher,
  watchFolderWithFs,
  type ArtifactWatcher,
  type WatchFolder,
} from './artifact-watch'
import { addTaskArtifact } from './artifacts'

/** A short wait, so the tests don't sit through the real one. */
const WAIT_MS = 30

let folder: string
let root: string
let database: TestDatabase
let events: GladeEvent[]
let taskId: string
let watcher: ArtifactWatcher | undefined

/** The folders being watched, with what each calls back. */
let watching: Map<string, (fileName: string | null) => void>
let closed: string[]

/** Watches folders in memory: a test calls `changeIn` for what `fs.watch` would report. */
const fakeWatchFolder: WatchFolder = (watched, onChange) => {
  if (watched.endsWith('gone')) throw new Error(`ENOENT: ${watched}`)
  watching.set(watched, onChange)
  return {
    close: () => {
      watching.delete(watched)
      closed.push(watched)
    },
  }
}

function changeIn(path: string, fileName: string | null): void {
  const onChange = watching.get(join(root, path))
  if (onChange === undefined) throw new Error(`${path} isn't watched`)
  onChange(fileName)
}

function at(minutes: number): Date {
  return new Date(1_700_000_000_000 + minutes * 60_000)
}

function write(path: string, when: Date, content = 'content'): void {
  const full = join(root, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
  utimesSync(full, when, when)
}

function start(watchFolder: WatchFolder = fakeWatchFolder): ArtifactWatcher {
  const context = {
    db: database.db,
    emit: (event: GladeEvent) => {
      events.push(event)
      // As the bridge does: the watcher hears its own changes too.
      watcher?.observe(event)
    },
  }
  watcher = createArtifactWatcher({ context, watchFolder, waitMs: WAIT_MS })
  return watcher
}

/** The artifacts' changes broadcast so far, each as the paths in order of when their files changed, newest first. */
function orders(): string[][] {
  return events
    .filter((event): event is ArtifactsChangedEvent => event.type === EventType.ArtifactsChanged)
    .map(({ artifacts }) => newestFirst(artifacts))
}

function newestFirst(artifacts: readonly Artifact[]): string[] {
  const time = (artifact: Artifact): EpochMs => artifact.modifiedAt ?? artifact.updatedAt
  return [...artifacts].sort((a, b) => time(b) - time(a)).map(({ path }) => path)
}

function modifiedAt(path: string): EpochMs | null | undefined {
  return listArtifacts(database.db, taskId).find((artifact) => artifact.path === path)?.modifiedAt
}

let toolCalls = 0

/** A tool call of the task's, finished unless said otherwise. */
function finished(name: string, input: ToolInput, state = ToolCallState.Done, owner = taskId): GladeEvent {
  toolCalls++
  const toolEvent: ToolCallEvent = {
    id: `e${String(toolCalls)}`,
    taskId: owner,
    turn: 1,
    createdAt: 1,
    kind: ToolEventKind.ToolCall,
    name,
    input,
    output: 'ok',
    state,
    finishedAt: state === ToolCallState.Running ? null : 2,
    toolUseId: `toolu_${String(toolCalls)}`,
    parentToolUseId: null,
    progressSummary: null,
  }
  return { type: EventType.ToolEventUpdated, toolEvent }
}

beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'glade-artifact-watch-'))
  // Real, so paths match the ones fs.watch and realpath give on macOS (/var is /private/var).
  root = join(realpathSync(folder), 'acme-docs')
  mkdirSync(root)
  database = openTestDatabase()
  events = []
  watching = new Map()
  closed = []
  taskId = sampleTask(database.db, sampleWorkspace(database.db, root).id).id
  write('out/screens/landing.png', at(0))
  write('out/screens/search.png', at(1))
  write('docs/site/changelog.md', at(2))
  const context = { db: database.db, emit: () => undefined }
  await addTaskArtifact(context, taskId, 'out/screens/landing.png', 'Landing page')
  await addTaskArtifact(context, taskId, 'out/screens/search.png', 'Search on mobile')
  await addTaskArtifact(context, taskId, 'docs/site/changelog.md', 'Changelog')
})

afterEach(() => {
  watcher?.close()
  watcher = undefined
  database.close()
  rmSync(folder, { recursive: true, force: true })
})

describe('a finished tool call', () => {
  it('moves the artifact it edited to the top, once the wait is over', async () => {
    const artifacts = start()
    write('out/screens/landing.png', at(10))

    artifacts.observe(finished('Edit', { file_path: join(root, 'out/screens/landing.png') }))
    expect(events).toEqual([])

    await vi.waitFor(() => {
      expect(orders()).toEqual([['out/screens/landing.png', 'docs/site/changelog.md', 'out/screens/search.png']])
    })
    expect(modifiedAt('out/screens/landing.png')).toBe(at(10).getTime())
  })

  it('counts Write, MultiEdit and NotebookEdit, by an absolute path or one relative to the workspace', async () => {
    const artifacts = start()
    write('out/screens/search.png', at(11))
    write('docs/site/changelog.md', at(12))

    artifacts.observe(finished('Write', { file_path: 'out/screens/search.png' }))
    artifacts.observe(finished('MultiEdit', { file_path: join(root, 'docs/site/changelog.md') }))

    await vi.waitFor(() => {
      expect(modifiedAt('docs/site/changelog.md')).toBe(at(12).getTime())
    })
    expect(modifiedAt('out/screens/search.png')).toBe(at(11).getTime())

    addArtifact(database.db, { taskId, path: 'notes/plan.ipynb', title: 'Plan' })
    write('notes/plan.ipynb', at(13))
    artifacts.observe(finished('NotebookEdit', { notebook_path: 'notes/plan.ipynb' }))
    await vi.waitFor(() => {
      expect(modifiedAt('notes/plan.ipynb')).toBe(at(13).getTime())
    })
  })

  it('counts a Bash command that names an artifact’s path, relative or absolute, and a failed one', async () => {
    const artifacts = start()
    write('out/screens/landing.png', at(20))
    write('out/screens/search.png', at(21))

    artifacts.observe(finished('Bash', { command: 'npx playwright screenshot / out/screens/landing.png' }))
    artifacts.observe(
      finished('Bash', { command: `convert x.png ${join(root, 'out/screens/search.png')}` }, ToolCallState.Error),
    )

    await vi.waitFor(() => {
      expect(modifiedAt('out/screens/search.png')).toBe(at(21).getTime())
    })
    expect(modifiedAt('out/screens/landing.png')).toBe(at(20).getTime())
  })

  it('leaves alone a call that’s still running, one that changed another file, and any other tool', async () => {
    const artifacts = start()
    write('out/screens/landing.png', at(30))

    artifacts.observe(finished('Edit', { file_path: 'out/screens/landing.png' }, ToolCallState.Running))
    artifacts.observe(finished('Edit', { file_path: 'src/app.ts' }))
    artifacts.observe(finished('Edit', { file_path: '/elsewhere/out/screens/landing.png' }))
    artifacts.observe(finished('Read', { file_path: 'out/screens/landing.png' }))
    artifacts.observe(finished('Bash', { command: 'npm test' }))
    artifacts.observe(finished('Bash', { script: 'out/screens/landing.png' }))
    artifacts.observe(finished('Edit', { file_path: 42 }))
    artifacts.observe({
      type: EventType.ToolEventUpdated,
      toolEvent: {
        id: 'n',
        taskId,
        turn: 1,
        createdAt: 1,
        kind: ToolEventKind.Narration,
        text: 'Hi',
        parentToolUseId: null,
      },
    })
    artifacts.observe({ type: EventType.TaskDeleted, taskId: 'other' })

    await new Promise((resolve) => setTimeout(resolve, WAIT_MS * 3))
    expect(events).toEqual([])
    expect(modifiedAt('out/screens/landing.png')).toBe(at(0).getTime())
  })

  it('does nothing for a task that’s gone', async () => {
    const artifacts = start()
    deleteTask(database.db, taskId)

    artifacts.observe(finished('Edit', { file_path: 'out/screens/landing.png' }))

    await new Promise((resolve) => setTimeout(resolve, WAIT_MS * 3))
    expect(events).toEqual([])
  })
})

describe('rapid edits', () => {
  it('are looked at once, when the wait after the first is over', async () => {
    const artifacts = start()
    artifacts.watch(taskId)
    await vi.waitFor(() => {
      expect(watching.size).toBe(2)
    })

    // Five saves in a row, each changing the file: each would move it, were it looked at at once.
    for (let save = 1; save <= 5; save++) {
      write('docs/site/changelog.md', at(40 + save))
      changeIn('docs/site', 'changelog.md')
      artifacts.observe(finished('Edit', { file_path: 'docs/site/changelog.md' }))
    }

    await vi.waitFor(() => {
      expect(orders()).toHaveLength(1)
    })
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS * 3))
    expect(orders()).toHaveLength(1)
    expect(modifiedAt('docs/site/changelog.md')).toBe(at(45).getTime())
  })

  it('in several files are looked at together', async () => {
    const artifacts = start()
    artifacts.watch(taskId)
    write('out/screens/landing.png', at(50))
    write('out/screens/search.png', at(51))

    changeIn('out/screens', 'landing.png')
    changeIn('out/screens', 'search.png')

    await vi.waitFor(() => {
      expect(orders()).toEqual([['out/screens/search.png', 'out/screens/landing.png', 'docs/site/changelog.md']])
    })
  })
})

describe('watching while the tab shows the task', () => {
  it('looks at every file at once, for edits made while the tab was closed', async () => {
    write('out/screens/search.png', at(60))

    start().watch(taskId)

    await vi.waitFor(() => {
      expect(orders()).toEqual([['out/screens/search.png', 'docs/site/changelog.md', 'out/screens/landing.png']])
    })
  })

  it('watches each folder the artifacts are in, once', () => {
    start().watch(taskId)

    expect([...watching.keys()].sort()).toEqual([join(root, 'docs/site'), join(root, 'out/screens')])
  })

  it('moves an artifact edited outside the agent, in the terminal or an editor', async () => {
    const artifacts = start()
    artifacts.watch(taskId)
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS))
    events = []

    write('out/screens/landing.png', at(70))
    changeIn('out/screens', 'landing.png')

    await vi.waitFor(() => {
      expect(orders()).toEqual([['out/screens/landing.png', 'docs/site/changelog.md', 'out/screens/search.png']])
    })
  })

  it('ignores a change to another file in the folder, and looks at all of its artifacts when it can’t tell which', async () => {
    const artifacts = start()
    artifacts.watch(taskId)
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS))
    events = []

    write('out/screens/other.png', at(80))
    changeIn('out/screens', 'other.png')
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS * 3))
    expect(events).toEqual([])

    write('out/screens/landing.png', at(81))
    write('out/screens/search.png', at(82))
    changeIn('out/screens', null)
    await vi.waitFor(() => {
      expect(orders()).toEqual([['out/screens/search.png', 'out/screens/landing.png', 'docs/site/changelog.md']])
    })
  })

  it('keeps a deleted file where it was, as missing', async () => {
    const artifacts = start()
    artifacts.watch(taskId)
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS))

    unlinkSync(join(root, 'out/screens/search.png'))
    changeIn('out/screens', 'search.png')

    await vi.waitFor(() => {
      expect(listArtifacts(database.db, taskId).find(({ path }) => path === 'out/screens/search.png')).toMatchObject({
        missing: true,
        modifiedAt: at(1).getTime(),
      })
    })
  })

  it('watches a new artifact’s folder, and lets go of one no artifact is in', async () => {
    const artifacts = start()
    artifacts.watch(taskId)
    write('site/redirects.yml', at(90))
    const context = {
      db: database.db,
      emit: (event: GladeEvent) => {
        artifacts.observe(event)
      },
    }

    await addTaskArtifact(context, taskId, 'site/redirects.yml', 'Redirect map')
    expect(watching.has(join(root, 'site'))).toBe(true)

    artifacts.observe({
      type: EventType.ArtifactsChanged,
      taskId,
      artifacts: listArtifacts(database.db, taskId),
    })
    database.db.prepare("DELETE FROM artifacts WHERE path LIKE 'docs/%'").run()
    artifacts.observe({ type: EventType.ArtifactsChanged, taskId, artifacts: listArtifacts(database.db, taskId) })
    expect(closed).toEqual([join(root, 'docs/site')])
    expect([...watching.keys()].sort()).toEqual([join(root, 'out/screens'), join(root, 'site')])
  })

  it('skips a folder that’s gone, and shows its artifact as missing', async () => {
    addArtifact(database.db, { taskId, path: 'gone/notes.md', title: 'Notes' })

    start().watch(taskId)

    expect(watching.has(join(root, 'gone'))).toBe(false)
    await vi.waitFor(() => {
      expect(listArtifacts(database.db, taskId).find(({ path }) => path === 'gone/notes.md')?.missing).toBe(true)
    })
  })

  it('keeps watching until every tab showing the task lets it go', () => {
    const artifacts = start()
    artifacts.watch(taskId)
    artifacts.watch(taskId)

    artifacts.unwatch(taskId)
    expect(watching.size).toBe(2)
    artifacts.unwatch(taskId)
    expect(watching.size).toBe(0)
    artifacts.unwatch(taskId)
    artifacts.unwatch('never-watched')
    expect(closed).toHaveLength(2)
  })

  it('stops watching a task’s folders once its artifacts change after it’s let go', () => {
    const artifacts = start()
    artifacts.watch(taskId)
    artifacts.unwatch(taskId)

    artifacts.observe({ type: EventType.ArtifactsChanged, taskId, artifacts: listArtifacts(database.db, taskId) })

    expect(watching.size).toBe(0)
  })

  it('watches nothing for a task that’s gone', () => {
    const artifacts = start()
    deleteTask(database.db, taskId)

    artifacts.watch(taskId)

    expect(watching.size).toBe(0)
  })

  it('stops everything when closed, and drops the changes still waiting', async () => {
    const artifacts = start()
    artifacts.watch(taskId)
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS))
    events = []
    write('out/screens/landing.png', at(100))
    changeIn('out/screens', 'landing.png')

    artifacts.close()

    expect(watching.size).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS * 3))
    expect(events).toEqual([])
  })
})

describe('watchFolderWithFs', () => {
  it('hears a file in the folder change, on disk, until it’s closed', async () => {
    const changes: (string | null)[] = []
    const folderWatch = watchFolderWithFs(join(root, 'out/screens'), (fileName) => changes.push(fileName))
    try {
      // FSEvents may take a moment to start listening.
      await vi.waitFor(
        () => {
          writeFileSync(join(root, 'out/screens/landing.png'), `edited ${String(Date.now())}`)
          expect(changes).toContain('landing.png')
        },
        { timeout: 5_000, interval: 100 },
      )
    } finally {
      folderWatch.close()
    }
  })

  it('throws for a folder that isn’t there', () => {
    expect(() => watchFolderWithFs(join(root, 'gone'), () => undefined)).toThrow(/ENOENT/)
  })
})

describe('ARTIFACT_CHANGE_WAIT_MS', () => {
  it('is short, so a change shows at once, and long enough to take in a burst of saves', () => {
    expect(ARTIFACT_CHANGE_WAIT_MS).toBeGreaterThanOrEqual(100)
    expect(ARTIFACT_CHANGE_WAIT_MS).toBeLessThanOrEqual(500)
  })

  it('is the wait by default', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const artifacts = createArtifactWatcher({
      context: { db: database.db, emit: (event) => events.push(event) },
      watchFolder: fakeWatchFolder,
    })
    try {
      write('out/screens/landing.png', at(110))
      artifacts.observe(finished('Edit', { file_path: 'out/screens/landing.png' }))

      vi.advanceTimersByTime(ARTIFACT_CHANGE_WAIT_MS - 1)
      await new Promise((resolve) => setImmediate(resolve))
      expect(modifiedAt('out/screens/landing.png')).toBe(at(0).getTime())
      vi.advanceTimersByTime(1)
      vi.useRealTimers()
      await vi.waitFor(() => {
        expect(modifiedAt('out/screens/landing.png')).toBe(at(110).getTime())
      })
    } finally {
      vi.useRealTimers()
      artifacts.close()
    }
  })
})
