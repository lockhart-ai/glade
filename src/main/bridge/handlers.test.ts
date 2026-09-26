import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { TaskFilter } from '../../shared/attention'
import { Effort, FileContentKind, FileInfoKind, TaskState, UiStateKey } from '../../shared/domain'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { BUILT_IN_MODELS } from '../../shared/models'
import { SDK_MODELS } from '../../shared/test-models'
import { BridgeErrorCode, CommandName, EventType, RendererErrorKind, type GladeEvent } from '../../shared/bridge'
import { EMPTY_MENU_STATE } from '../../shared/commands'
import { SearchField } from '../../shared/search'
import { FakeAgentBackend } from '../agent/fake-backend'
import { createAgentRunner } from '../agent/runner'
import { addArtifact } from '../db/repositories/artifacts'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { getSettings } from '../db/repositories/settings'
import { setSdkModels } from '../db/repositories/sdk-models'
import { getTask, listTasks, updateTask } from '../db/repositories/tasks'
import { setUiState } from '../db/repositories/ui-state'
import { createFakeSpawner, fakeTerminalOptions, type FakeSpawner } from '../terminal/fake-pty'
import { createPlugins } from '../plugins/plugins'
import { writePlugin } from '../plugins/test-plugins'
import { createFakePluginViews, type FakePluginViews } from '../plugins/fake-view'
import { createPluginFeed } from '../plugins/feed'
import { databaseFeedSource } from '../plugins/feed-source'
import { createPluginViews, type PluginViews } from '../plugins/views'
import type { Plugins } from '../plugins/plugins'
import { PluginStatus } from '../../shared/plugins'
import { createTerminals } from '../terminal/terminals'
import { createControlEndpoint, type ControlEndpoint } from '../control/endpoint'
import { createAccountTracker } from '../account/account'
import { createRateLimiter } from '../control/rate-limit'
import { createControl } from '../control/control'
import { createHandlers, type Handlers } from './handlers'
import type { MenuBarCommands } from '../menu-bar/menu-bar'
import { LogLevel, LogScope } from '../logging/logger'
import { createMemoryLog } from '../logging/memory-sink'

let database: TestDatabase
let root: string
let emit: Mock<(event: GladeEvent) => void>
let chooseFolder: Mock<() => Promise<string | null>>
let openPath: Mock<(path: string) => Promise<string>>
let revealPath: Mock<(path: string) => void>
let writeClipboard: Mock<(text: string) => Promise<void>>
let handlers: Handlers
let spawner: FakeSpawner
let views: FakePluginViews

/** The control endpoint, over the test's database; never started here (see `src/main/control/endpoint.test.ts`). */
function endpointOf(): ControlEndpoint {
  return createControlEndpoint({
    db: database.db,
    emit,
    limiter: createRateLimiter(),
    control: createControl({
      db: database.db,
      emit,
      runner: createAgentRunner({ db: database.db, emit, backend: new FakeAgentBackend() }),
    }),
  })
}

/** The plugins in the test's plugins folder, with their views made by `views`. */
function pluginsWithViews(): { plugins: Plugins; pluginViews: PluginViews } {
  const folder = join(root, 'plugins')
  const feed = createPluginFeed({ source: databaseFeedSource(database.db), tasks: [] })
  const pluginViews = createPluginViews({ emit, feed, folder, appVersion: '1.2.3', createView: views.create })
  const plugins = createPlugins({
    db: database.db,
    emit,
    folder,
    openPath,
    onUpdate: (list) => {
      pluginViews.update(list)
    },
  })
  return { plugins, pluginViews }
}

beforeEach(() => {
  database = openTestDatabase()
  root = mkdtempSync(join(tmpdir(), 'glade-handlers-'))
  emit = vi.fn()
  chooseFolder = vi.fn(() => Promise.resolve(root))
  openPath = vi.fn(() => Promise.resolve(''))
  revealPath = vi.fn()
  writeClipboard = vi.fn(() => Promise.resolve())
  views = createFakePluginViews()
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
    ...pluginsWithViews(),
    endpoint: endpointOf(),
    account: createAccountTracker({ db: database.db, emit }),
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

describe('workspaces.remove', () => {
  it('removes the workspace and its tasks, broadcasting it', async () => {
    const workspace = sampleWorkspace(database.db)
    const task = sampleTask(database.db, workspace.id)

    expect(await handlers[CommandName.WorkspacesRemove]({ id: workspace.id })).toBeNull()

    expect(listTasks(database.db, workspace.id)).toEqual([])
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: EventType.TaskDeleted, taskId: task.id },
      { type: EventType.WorkspaceRemoved, workspaceId: workspace.id },
    ])
  })
})

describe('menu.update and window.close', () => {
  it('rebuild the menu bar and close the window, through the app', async () => {
    const runner = createAgentRunner({ db: database.db, emit, backend: new FakeAgentBackend() })
    const updateMenu = vi.fn()
    const closeWindow = vi.fn()
    const withApp = createHandlers({
      db: database.db,
      emit,
      chooseFolder,
      openPath,
      revealPath,
      writeClipboard,
      runner,
      updateMenu,
      closeWindow,
      terminals: createTerminals({ db: database.db, emit, ...fakeTerminalOptions() }),
      ...pluginsWithViews(),
      endpoint: endpointOf(),
      account: createAccountTracker({ db: database.db, emit }),
    })

    expect(await withApp[CommandName.MenuUpdate](EMPTY_MENU_STATE)).toBeNull()
    expect(await withApp[CommandName.WindowClose]({})).toBeNull()

    expect(updateMenu).toHaveBeenCalledWith(EMPTY_MENU_STATE)
    expect(closeWindow).toHaveBeenCalledOnce()
  })

  it('do nothing without an app', async () => {
    expect(await handlers[CommandName.MenuUpdate](EMPTY_MENU_STATE)).toBeNull()
    expect(await handlers[CommandName.WindowClose]({})).toBeNull()
  })
})

describe('the menu bar commands', () => {
  function withMenuBar(): { menuBar: MenuBarCommands; calls: string[]; handlers: Handlers } {
    const calls: string[] = []
    const menuBar: MenuBarCommands = {
      openTask: (id) => calls.push(`openTask ${id}`),
      openGlade: () => calls.push('openGlade'),
      hide: () => calls.push('hide'),
      quit: () => calls.push('quit'),
      fit: (height) => calls.push(`fit ${String(height)}`),
    }
    const runner = createAgentRunner({ db: database.db, emit, backend: new FakeAgentBackend() })
    const withApp = createHandlers({
      db: database.db,
      emit,
      chooseFolder,
      openPath,
      revealPath,
      writeClipboard,
      runner,
      terminals: createTerminals({ db: database.db, emit, ...fakeTerminalOptions() }),
      ...pluginsWithViews(),
      endpoint: endpointOf(),
      account: createAccountTracker({ db: database.db, emit }),
      menuBar,
    })
    return { menuBar, calls, handlers: withApp }
  }

  it("answers what's in flight across every workspace", async () => {
    const task = sampleTask(database.db, sampleWorkspace(database.db).id)
    updateTask(database.db, task.id, { title: 'Add rate limiting', sessionId: 'session-1' })
    const { snapshot } = await handlers[CommandName.MenuBarGet]({})
    expect(snapshot.needsYou.map(({ taskId }) => taskId)).toEqual([task.id])
    expect(snapshot.working).toEqual([])
  })

  it('hands opening a task, opening Glade, hiding, quitting and sizing to the menu bar', async () => {
    const task = sampleTask(database.db, sampleWorkspace(database.db).id)
    const { calls, handlers: withApp } = withMenuBar()
    expect(await withApp[CommandName.MenuBarOpenTask]({ id: task.id })).toBeNull()
    expect(await withApp[CommandName.MenuBarOpenGlade]({})).toBeNull()
    expect(await withApp[CommandName.MenuBarHide]({})).toBeNull()
    expect(await withApp[CommandName.MenuBarFit]({ height: 412 })).toBeNull()
    expect(await withApp[CommandName.MenuBarQuit]({})).toBeNull()
    expect(calls).toEqual([`openTask ${task.id}`, 'openGlade', 'hide', 'fit 412', 'quit'])
  })

  it("refuses to open a task that isn't there", () => {
    const { calls, handlers: withApp } = withMenuBar()
    expect(() => withApp[CommandName.MenuBarOpenTask]({ id: 'gone' })).toThrow(
      expect.objectContaining({ code: BridgeErrorCode.NotFound }),
    )
    expect(calls).toEqual([])
  })

  it('do nothing without a menu bar', async () => {
    const task = sampleTask(database.db, sampleWorkspace(database.db).id)
    expect(await handlers[CommandName.MenuBarOpenTask]({ id: task.id })).toBeNull()
    expect(await handlers[CommandName.MenuBarOpenGlade]({})).toBeNull()
    expect(await handlers[CommandName.MenuBarHide]({})).toBeNull()
    expect(await handlers[CommandName.MenuBarFit]({ height: 1 })).toBeNull()
    expect(await handlers[CommandName.MenuBarQuit]({})).toBeNull()
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

describe('workspaces.update', () => {
  it('renames a workspace or moves its root, and broadcasts it', async () => {
    const workspace = sampleWorkspace(database.db)

    const renamed = await handlers[CommandName.WorkspacesUpdate]({ id: workspace.id, patch: { name: 'Acme' } })
    const moved = await handlers[CommandName.WorkspacesUpdate]({ id: workspace.id, patch: { rootPath: root } })

    expect(renamed).toEqual({ workspace: { ...workspace, name: 'Acme' } })
    expect(moved).toEqual({ workspace: { ...workspace, name: 'Acme', rootPath: root } })
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: EventType.WorkspaceUpdated, workspace: renamed.workspace },
      { type: EventType.WorkspaceUpdated, workspace: moved.workspace },
    ])
  })
})

describe('the settings commands', () => {
  it('answer with the settings, and save and broadcast a change', async () => {
    expect(handlers[CommandName.SettingsGet]({})).toEqual({ settings: DEFAULT_SETTINGS })

    const changed = await handlers[CommandName.SettingsUpdate]({ patch: { defaultEffort: Effort.Max } })

    const settings = { ...DEFAULT_SETTINGS, defaultEffort: Effort.Max }
    expect(changed).toEqual({ settings })
    expect(getSettings(database.db)).toEqual(settings)
    expect(emit).toHaveBeenCalledExactlyOnceWith({ type: EventType.SettingsChanged, settings })
  })

  it('keep the default effort a new default model supports, and fall back to its default otherwise', async () => {
    setSdkModels(database.db, SDK_MODELS)
    await handlers[CommandName.SettingsUpdate]({ patch: { defaultModel: 'default', defaultEffort: Effort.XHigh } })

    expect((await handlers[CommandName.SettingsUpdate]({ patch: { defaultModel: 'sonnet' } })).settings).toMatchObject({
      defaultModel: 'sonnet',
      defaultEffort: Effort.XHigh,
    })
    const lite = await handlers[CommandName.SettingsUpdate]({ patch: { defaultModel: 'lite' } })
    expect(lite.settings).toMatchObject({ defaultModel: 'lite', defaultEffort: Effort.Low })
    expect(emit).toHaveBeenLastCalledWith({ type: EventType.SettingsChanged, settings: lite.settings })
    // Haiku takes none: the default effort stays, for the next model.
    await handlers[CommandName.SettingsUpdate]({ patch: { defaultModel: 'default', defaultEffort: Effort.Max } })
    expect(
      (await handlers[CommandName.SettingsUpdate]({ patch: { defaultModel: 'haiku' } })).settings.defaultEffort,
    ).toBe(Effort.Max)
  })

  it('answer with the models the pickers offer: the built-in ones, then the SDK’s', () => {
    expect(handlers[CommandName.ModelsList]({})).toEqual({ models: BUILT_IN_MODELS })

    setSdkModels(database.db, SDK_MODELS)

    expect(handlers[CommandName.ModelsList]({})).toEqual({ models: SDK_MODELS })
  })

  it('answer with the control endpoint as it is, off to begin with', () => {
    expect(handlers[CommandName.ControlStatus]({})).toEqual({
      status: {
        enabled: false,
        chosenPort: DEFAULT_SETTINGS.controlPort,
        port: null,
        url: null,
        token: null,
        error: null,
      },
    })
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

describe('the task list commands', () => {
  it('answer the tasks outside the Done section with its counts, a page of it, and tasks by id', async () => {
    const workspace = sampleWorkspace(database.db)
    const active = sampleTask(database.db, workspace.id, 1_000)
    const older = updateTask(database.db, sampleTask(database.db, workspace.id).id, { state: TaskState.Done }, 2_000)
    const newer = updateTask(
      database.db,
      sampleTask(database.db, workspace.id).id,
      { state: TaskState.Done, unread: true },
      3_000,
    )

    expect(await handlers[CommandName.TasksListActive]({ workspaceId: workspace.id })).toEqual({
      tasks: [active],
      done: { all: 2, unread: 1 },
    })
    const request = { workspaceId: workspace.id, filter: TaskFilter.All, after: null, limit: 1 }
    expect(await handlers[CommandName.TasksListDone](request)).toEqual({ tasks: [newer], hasMore: true })
    expect(
      await handlers[CommandName.TasksListDone]({ ...request, after: { updatedAt: newer.updatedAt, id: newer.id } }),
    ).toEqual({ tasks: [older], hasMore: false })
    expect(await handlers[CommandName.TasksGet]({ ids: [older.id, 'gone'] })).toEqual({ tasks: [older] })
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

describe('log.rendererError', () => {
  it('logs the error the window sent, in the renderer scope, and answers with nothing', async () => {
    const log = createMemoryLog()
    const logging = createHandlers({
      db: database.db,
      emit,
      chooseFolder,
      openPath,
      revealPath,
      writeClipboard,
      runner: createAgentRunner({ db: database.db, emit, backend: new FakeAgentBackend() }),
      terminals: createTerminals({ db: database.db, emit, ...fakeTerminalOptions(spawner) }),
      ...pluginsWithViews(),
      endpoint: endpointOf(),
      account: createAccountTracker({ db: database.db, emit }),
      log: log.logger,
    })
    const error = {
      kind: RendererErrorKind.UnhandledRejection,
      message: 'Error: fetch failed',
      stack: null,
      componentStack: null,
      source: null,
    }

    expect(await logging[CommandName.LogRendererError](error)).toBeNull()
    expect(log.records).toEqual([
      expect.objectContaining({
        level: LogLevel.Error,
        scope: LogScope.Renderer,
        message: 'renderer error',
        fields: error,
      }),
    ])
  })

  it('logs nothing when it has no log', async () => {
    const error = vi.spyOn(console, 'error')
    await handlers[CommandName.LogRendererError]({
      kind: RendererErrorKind.Error,
      message: 'x',
      stack: null,
      componentStack: null,
      source: null,
    })
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })
})

describe('plugins', () => {
  it('lists the plugins folder, turns a plugin off, and opens the folder', async () => {
    writePlugin(join(root, 'plugins'), 'pomodoro')

    const { plugins } = await handlers[CommandName.PluginsList]({})
    expect(plugins).toMatchObject([{ folder: 'pomodoro', status: PluginStatus.Valid, enabled: true }])

    const off = await handlers[CommandName.PluginsSetEnabled]({ id: 'pomodoro', enabled: false })
    expect(off).toEqual({ plugins: [{ ...plugins[0], enabled: false }] })
    expect(emit).toHaveBeenLastCalledWith({ type: EventType.PluginsChanged, plugins: off.plugins })

    expect(await handlers[CommandName.PluginsOpenFolder]({})).toBeNull()
    expect(openPath).toHaveBeenCalledExactlyOnceWith(join(root, 'plugins'))
  })
})

describe('plugins.placeView', () => {
  const bounds = { x: 700, y: 540, width: 680, height: 255 }

  it("puts an enabled plugin's view over its card, and answers with its status", async () => {
    writePlugin(join(root, 'plugins'), 'pomodoro')
    await handlers[CommandName.PluginsList]({})

    expect(await handlers[CommandName.PluginsPlaceView]({ id: 'pomodoro', bounds })).toEqual({ status: '' })
    expect(views.last()).toMatchObject({ bounds, spec: { folder: join(root, 'plugins', 'pomodoro') } })

    views.last().post({ type: 'status', text: '3 pomodoros' })
    expect(await handlers[CommandName.PluginsPlaceView]({ id: 'pomodoro', bounds: null })).toEqual({
      status: '3 pomodoros',
    })
    expect(views.last().bounds).toBeNull()
  })

  it('destroys the view when the plugin is turned off, and refuses to place it', async () => {
    writePlugin(join(root, 'plugins'), 'pomodoro')
    await handlers[CommandName.PluginsList]({})
    await handlers[CommandName.PluginsPlaceView]({ id: 'pomodoro', bounds })

    await handlers[CommandName.PluginsSetEnabled]({ id: 'pomodoro', enabled: false })

    expect(views.last().destroyed).toBe(true)
    await expect(
      Promise.resolve().then(() => handlers[CommandName.PluginsPlaceView]({ id: 'pomodoro', bounds })),
    ).rejects.toMatchObject({ code: BridgeErrorCode.NotFound })
    expect(views.views).toHaveLength(1)
  })
})
