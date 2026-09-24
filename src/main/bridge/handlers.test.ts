import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { CommandName, EventType, type GladeEvent } from '../../shared/bridge'
import { FileContentKind, FileInfoKind, UiStateKey } from '../../shared/domain'
import { FakeAgentBackend } from '../agent/fake-backend'
import { createAgentRunner } from '../agent/runner'
import { addArtifact } from '../db/repositories/artifacts'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { setUiState } from '../db/repositories/ui-state'
import { createHandlers, type Handlers } from './handlers'

let database: TestDatabase
let root: string
let emit: Mock<(event: GladeEvent) => void>
let chooseFolder: Mock<() => Promise<string | null>>
let openPath: Mock<(path: string) => Promise<string>>
let revealPath: Mock<(path: string) => void>
let writeClipboard: Mock<(text: string) => Promise<void>>
let handlers: Handlers

beforeEach(() => {
  database = openTestDatabase()
  root = mkdtempSync(join(tmpdir(), 'glade-handlers-'))
  emit = vi.fn()
  chooseFolder = vi.fn(() => Promise.resolve(root))
  openPath = vi.fn(() => Promise.resolve(''))
  revealPath = vi.fn()
  writeClipboard = vi.fn(() => Promise.resolve())
  const runner = createAgentRunner({ db: database.db, emit, backend: new FakeAgentBackend() })
  handlers = createHandlers({ db: database.db, emit, chooseFolder, openPath, revealPath, writeClipboard, runner })
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

describe('workspaces.create', () => {
  it('broadcasts a workspace it adds', async () => {
    const { workspace, created } = await handlers[CommandName.WorkspacesCreate]({ rootPath: root })

    expect(created).toBe(true)
    expect(emit).toHaveBeenCalledExactlyOnceWith({ type: EventType.WorkspaceUpdated, workspace })
  })

  it('broadcasts nothing when answering with an existing workspace', async () => {
    const first = await handlers[CommandName.WorkspacesCreate]({ rootPath: root })
    emit.mockClear()

    expect(await handlers[CommandName.WorkspacesCreate]({ rootPath: root })).toEqual({ ...first, created: false })
    expect(emit).not.toHaveBeenCalled()
  })
})

describe('workspaces.open', () => {
  it('broadcasts the opened workspace and each UI state value it changed', async () => {
    const other = sampleWorkspace(database.db, '/code/acme-web')
    const workspace = sampleWorkspace(database.db)
    setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: sampleTask(database.db, other.id).id })

    const opened = await handlers[CommandName.WorkspacesOpen]({ id: workspace.id })

    expect(opened.workspace.lastOpenedAt).toBeGreaterThanOrEqual(workspace.lastOpenedAt)
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: EventType.WorkspaceUpdated, workspace: opened.workspace },
      { type: EventType.UiStateChanged, entry: { key: UiStateKey.ActiveWorkspaceId, value: workspace.id } },
      { type: EventType.UiStateChanged, entry: { key: UiStateKey.SelectedTaskId, value: '' } },
    ])
  })
})

describe('the files commands', () => {
  function taskInRoot(): string {
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs', 'rate-limits.md'), '# Rate limits\n')
    return sampleTask(database.db, sampleWorkspace(database.db, root).id).id
  }

  it('read a file of the task’s workspace', async () => {
    const taskId = taskInRoot()

    await expect(handlers[CommandName.FilesRead]({ taskId, path: 'docs/rate-limits.md' })).resolves.toEqual({
      content: { kind: FileContentKind.Text, text: '# Rate limits\n', truncated: false, size: 14 },
    })
  })

  it('open and close files, broadcasting each change, and the history carries them', async () => {
    const taskId = taskInRoot()

    const opened = await handlers[CommandName.FilesOpen]({ taskId, path: 'docs/rate-limits.md' })
    const again = await handlers[CommandName.FilesOpen]({ taskId, path: 'src/throttles.py' })
    const closed = await handlers[CommandName.FilesClose]({ taskId, path: 'src/throttles.py' })

    expect(opened).toEqual({ openFiles: { taskId, paths: ['docs/rate-limits.md'], activePath: 'docs/rate-limits.md' } })
    expect(again.openFiles.activePath).toBe('src/throttles.py')
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: EventType.OpenFilesChanged, openFiles: opened.openFiles },
      { type: EventType.OpenFilesChanged, openFiles: again.openFiles },
      { type: EventType.OpenFilesChanged, openFiles: closed.openFiles },
    ])
    const history = await handlers[CommandName.TasksHistory]({ id: taskId })
    expect(history.openFiles).toEqual(opened.openFiles)
  })

  it('describe, copy and reveal a file, and the history carries the task’s artifacts', async () => {
    const taskId = taskInRoot()
    addArtifact(database.db, { taskId, path: 'docs/rate-limits.md', title: 'Rate limits' }, 5)

    await expect(handlers[CommandName.FilesInfo]({ taskId, path: 'docs/rate-limits.md' })).resolves.toMatchObject({
      info: { kind: FileInfoKind.Text, lines: 1 },
    })
    await expect(handlers[CommandName.FilesCopy]({ taskId, path: 'docs/rate-limits.md' })).resolves.toBeNull()
    await expect(handlers[CommandName.FilesReveal]({ taskId, path: 'docs/rate-limits.md' })).resolves.toBeNull()

    expect(writeClipboard).toHaveBeenCalledExactlyOnceWith('# Rate limits\n')
    expect(revealPath).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/\/docs\/rate-limits\.md$/))
    const history = await handlers[CommandName.TasksHistory]({ id: taskId })
    expect(history.artifacts).toEqual([
      { taskId, path: 'docs/rate-limits.md', title: 'Rate limits', addedAt: 5, updatedAt: 5 },
    ])
  })

  it('open a file in the editor by its real path', async () => {
    const taskId = taskInRoot()

    await expect(handlers[CommandName.FilesOpenInEditor]({ taskId, path: 'docs/rate-limits.md' })).resolves.toBeNull()
    expect(openPath).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/\/docs\/rate-limits\.md$/))
  })
})

describe('clipboard.writeText', () => {
  it('puts the text on the clipboard', async () => {
    await expect(handlers[CommandName.ClipboardWriteText]({ text: 'glade://task/t1' })).resolves.toBeNull()
    expect(writeClipboard).toHaveBeenCalledExactlyOnceWith('glade://task/t1')
  })
})

describe('dialog.chooseFolder', () => {
  it('answers with the chosen folder, or null when cancelled', async () => {
    await expect(handlers[CommandName.DialogChooseFolder]({})).resolves.toEqual({ path: root })
    chooseFolder.mockResolvedValueOnce(null)
    await expect(handlers[CommandName.DialogChooseFolder]({})).resolves.toEqual({ path: null })
  })
})
