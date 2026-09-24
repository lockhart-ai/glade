import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { BridgeErrorCode, CommandName, EventType, type GladeEvent } from '../../shared/bridge'
import { FileContentKind, FileInfoKind, UiStateKey } from '../../shared/domain'
import { SearchField } from '../../shared/search'
import { FakeAgentBackend } from '../agent/fake-backend'
import { createAgentRunner } from '../agent/runner'
import { addArtifact } from '../db/repositories/artifacts'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { getTask, updateTask } from '../db/repositories/tasks'
import { setUiState } from '../db/repositories/ui-state'
import { createFakeSpawner, fakeTerminalOptions, type FakeSpawner } from '../terminal/fake-pty'
import { createTerminals } from '../terminal/terminals'
import { createHandlers, type Handlers } from './handlers'

let database: TestDatabase
let root: string
let emit: Mock<(event: GladeEvent) => void>
let chooseFolder: Mock<() => Promise<string | null>>
let openPath: Mock<(path: string) => Promise<string>>
let revealPath: Mock<(path: string) => void>
let writeClipboard: Mock<(text: string) => Promise<void>>
let handlers: Handlers
let spawner: FakeSpawner

beforeEach(() => {
  database = openTestDatabase()
  root = mkdtempSync(join(tmpdir(), 'glade-handlers-'))
  emit = vi.fn()
  chooseFolder = vi.fn(() => Promise.resolve(root))
  openPath = vi.fn(() => Promise.resolve(''))
  revealPath = vi.fn()
  writeClipboard = vi.fn(() => Promise.resolve())
  const runner = createAgentRunner({ db: database.db, emit, backend: new FakeAgentBackend() })
  spawner = createFakeSpawner()
  const terminals = createTerminals({ db: database.db, emit, ...fakeTerminalOptions(spawner) })
  handlers = createHandlers({
    db: database.db,
    emit,
    chooseFolder,
    openPath,
    revealPath,
    writeClipboard,
    runner,
    terminals,
  })
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

  it('restores the task last selected in the workspace, which is then read', async () => {
    const acme = sampleWorkspace(database.db)
    const web = sampleWorkspace(database.db, '/code/acme-web')
    const inAcme = sampleTask(database.db, acme.id)
    const inWeb = sampleTask(database.db, web.id)
    await handlers[CommandName.WorkspacesOpen]({ id: acme.id })
    await handlers[CommandName.UiStateSet]({ key: UiStateKey.SelectedTaskId, value: inAcme.id })
    await handlers[CommandName.WorkspacesOpen]({ id: web.id })
    await handlers[CommandName.UiStateSet]({ key: UiStateKey.SelectedTaskId, value: inWeb.id })
    updateTask(database.db, inAcme.id, { unread: true })
    emit.mockClear()

    const opened = await handlers[CommandName.WorkspacesOpen]({ id: acme.id })

    expect(opened.selectedTaskId).toBe(inAcme.id)
    expect(emit).toHaveBeenCalledWith({
      type: EventType.UiStateChanged,
      entry: { key: UiStateKey.SelectedTaskId, value: inAcme.id },
    })
    expect(getTask(database.db, inAcme.id)?.unread).toBe(false)
    expect((await handlers[CommandName.WorkspacesOpen]({ id: web.id })).selectedTaskId).toBe(inWeb.id)
  })
})

describe('workspaces.reveal', () => {
  it('shows the workspace root in Finder', () => {
    const workspace = sampleWorkspace(database.db)

    expect(handlers[CommandName.WorkspacesReveal]({ id: workspace.id })).toBeNull()

    expect(revealPath).toHaveBeenCalledExactlyOnceWith('/code/acme-api')
  })

  it('refuses an unknown workspace', () => {
    expect(() => handlers[CommandName.WorkspacesReveal]({ id: 'gone' })).toThrow('No workspace gone')
    expect(revealPath).not.toHaveBeenCalled()
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

describe('artifacts.remove', () => {
  it('takes a file off the task’s artifacts, broadcasting what’s left, and refuses one that isn’t there', async () => {
    const taskId = sampleTask(database.db, sampleWorkspace(database.db, root).id).id
    addArtifact(database.db, { taskId, path: 'docs/notes.md', title: 'Notes' }, 5)
    const email = addArtifact(database.db, { taskId, path: 'out/email.txt', title: 'Email' }, 6)

    expect(handlers[CommandName.ArtifactsRemove]({ taskId, path: 'docs/notes.md' })).toBeNull()

    expect(emit).toHaveBeenCalledExactlyOnceWith({ type: EventType.ArtifactsChanged, taskId, artifacts: [email] })
    expect((await handlers[CommandName.TasksHistory]({ id: taskId })).artifacts).toEqual([email])
    expect(() => handlers[CommandName.ArtifactsRemove]({ taskId, path: 'docs/notes.md' })).toThrow(
      expect.objectContaining({ code: BridgeErrorCode.NotFound }),
    )
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

describe('search.query', () => {
  it('answers with the workspace’s matching tasks', () => {
    const workspace = sampleWorkspace(database.db)
    const task = sampleTask(database.db, workspace.id)
    updateTask(database.db, task.id, { title: 'Add rate limiting' })

    expect(handlers[CommandName.SearchQuery]({ workspaceId: workspace.id, text: 'rate' })).toEqual({
      results: [
        {
          taskId: task.id,
          field: SearchField.Title,
          snippet: [
            { text: 'Add ', match: false },
            { text: 'rate', match: true },
            { text: ' limiting', match: false },
          ],
        },
      ],
    })
    expect(handlers[CommandName.SearchQuery]({ workspaceId: workspace.id, text: '' })).toEqual({ results: [] })
  })
})

describe('the terminal commands', () => {
  it('starts a new tab in the workspace root, or the fallback folder with none, and refuses an unknown workspace', async () => {
    const workspace = sampleWorkspace(database.db, root)
    const { tab } = await handlers[CommandName.TerminalCreate]({ workspaceId: workspace.id })
    expect(tab).toMatchObject({ cwd: root, name: null, process: 'zsh', running: false })
    const { tab: homeless } = await handlers[CommandName.TerminalCreate]({ workspaceId: null })
    expect(homeless.cwd).toBe(tmpdir())
    await expect(async () => handlers[CommandName.TerminalCreate]({ workspaceId: 'gone' })).rejects.toMatchObject({
      code: BridgeErrorCode.NotFound,
    })
    expect((await handlers[CommandName.TerminalList]({})).tabs.map(({ id }) => id)).toEqual([tab.id, homeless.id])
  })

  it('runs a tab: attaches, types, resizes, renames, clears, interrupts, duplicates and closes it', async () => {
    const { tab } = await handlers[CommandName.TerminalCreate]({ workspaceId: null })
    expect(await handlers[CommandName.TerminalAttach]({ id: tab.id, cols: 80, rows: 24 })).toEqual({
      output: '',
      end: 0,
    })
    const [pty] = spawner.spawned
    if (pty === undefined) throw new Error('No shell started')
    pty.output('$ ')
    expect(await handlers[CommandName.TerminalWrite]({ id: tab.id, data: 'ls\r' })).toBeNull()
    expect(pty.written).toEqual(['ls\r'])
    expect(await handlers[CommandName.TerminalResize]({ id: tab.id, cols: 100, rows: 30 })).toBeNull()
    expect(pty.size).toEqual({ cols: 100, rows: 30 })
    expect(await handlers[CommandName.TerminalRename]({ id: tab.id, name: '  server ' })).toBeNull()
    expect((await handlers[CommandName.TerminalList]({})).tabs[0]?.name).toBe('server')
    expect(await handlers[CommandName.TerminalClear]({ id: tab.id })).toBeNull()
    expect(emit).toHaveBeenCalledWith({ type: EventType.TerminalCleared, tabId: tab.id })
    expect(await handlers[CommandName.TerminalInterrupt]({ id: tab.id })).toBeNull()
    expect(pty.interrupts).toBe(1)
    const { tab: copy } = await handlers[CommandName.TerminalDuplicate]({ id: tab.id })
    expect(copy).toMatchObject({ name: 'server', cwd: tab.cwd })
    expect(await handlers[CommandName.TerminalClose]({ id: tab.id })).toBeNull()
    expect(pty.killed).toBe(true)
    expect((await handlers[CommandName.TerminalList]({})).tabs.map(({ id }) => id)).toEqual([copy.id])
  })
})
