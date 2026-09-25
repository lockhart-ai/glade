import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import {
  FileContentKind,
  FileInfoKind,
  UiStateKey,
  type Message,
  type OpenFiles,
  type PermissionRequest,
  type QuestionSet,
  type QueuedMessage,
  type Task,
} from '../../shared/domain'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { commandTaskId, createBroadcast, createDispatcher } from './dispatcher'
import { CommandFailure } from './errors'
import type { TerminalTab } from '../../shared/terminal'
import type { Handlers } from './handlers'
import { REQUEST_SCHEMAS } from './requests'
import { LogLevel, LogScope } from '../logging/logger'
import { createMemoryLog, type MemoryLog } from '../logging/memory-sink'

function handlers(overrides: Partial<Handlers> = {}): Handlers {
  return {
    [CommandName.WorkspacesList]: () => ({ workspaces: [] }),
    [CommandName.WorkspacesCreate]: () => {
      throw new Error('not in these tests')
    },
    [CommandName.WorkspacesOpen]: () => {
      throw new Error('not in these tests')
    },
    [CommandName.WorkspacesReveal]: () => null,
    [CommandName.WorkspacesRemove]: () => null,
    [CommandName.MenuUpdate]: () => null,
    [CommandName.WindowClose]: () => null,
    [CommandName.LogRendererError]: () => null,
    [CommandName.DialogChooseFolder]: () => ({ path: null }),
    [CommandName.TasksList]: () => ({ tasks: [] }),
    [CommandName.TasksCreate]: () => ({ task: {} as Task }),
    [CommandName.TasksMarkDone]: () => ({ task: {} as Task }),
    [CommandName.TasksReopen]: () => ({ task: {} as Task }),
    [CommandName.TasksUpdate]: () => ({ task: {} as Task }),
    [CommandName.TasksDelete]: () => null,
    [CommandName.TasksSend]: () => ({ message: {} as Message }),
    [CommandName.TasksStop]: () => ({ task: {} as Task }),
    [CommandName.TasksRetry]: () => ({ task: {} as Task }),
    [CommandName.TasksCompact]: () => ({ task: {} as Task }),
    [CommandName.TasksHistory]: () => ({
      messages: [],
      toolEvents: [],
      queuedMessages: [],
      questionSets: [],
      permissionRequests: [],
      openFiles: { taskId: 't', paths: [], activePath: null },
      todos: null,
      artifacts: [],
    }),
    [CommandName.QueueAdd]: () => ({ queuedMessage: {} as QueuedMessage }),
    [CommandName.QueueEdit]: () => ({ queuedMessage: {} as QueuedMessage }),
    [CommandName.QueueRemove]: () => null,
    [CommandName.ImagesGet]: () => {
      throw new Error('not in these tests')
    },
    [CommandName.QuestionsAnswer]: () => ({ questionSet: {} as QuestionSet }),
    [CommandName.PermissionsAnswer]: () => ({ permissionRequest: {} as PermissionRequest }),
    [CommandName.FilesRead]: () => ({ content: { kind: FileContentKind.Missing } }),
    [CommandName.FilesOpen]: () => ({ openFiles: {} as OpenFiles }),
    [CommandName.FilesClose]: () => ({ openFiles: {} as OpenFiles }),
    [CommandName.FilesOpenInEditor]: () => null,
    [CommandName.SubagentsStop]: () => null,
    [CommandName.ClipboardWriteText]: () => null,
    [CommandName.FilesInfo]: () => ({ info: { kind: FileInfoKind.Missing } }),
    [CommandName.FilesCopy]: () => null,
    [CommandName.FilesReveal]: () => null,
    [CommandName.ArtifactsRemove]: () => null,
    [CommandName.UiStateGet]: () => Promise.resolve({ value: 'async' }),
    [CommandName.UiStateGetAll]: () => ({ entries: [] }),
    [CommandName.SearchQuery]: () => ({ results: [] }),
    [CommandName.UiStateSet]: () => null,
    [CommandName.TerminalList]: () => ({ tabs: [] }),
    [CommandName.TerminalCreate]: () => ({ tab: {} as TerminalTab }),
    [CommandName.TerminalDuplicate]: () => ({ tab: {} as TerminalTab }),
    [CommandName.TerminalAttach]: () => ({ output: '', end: 0 }),
    [CommandName.TerminalWrite]: () => null,
    [CommandName.TerminalResize]: () => null,
    [CommandName.TerminalRename]: () => null,
    [CommandName.TerminalClear]: () => null,
    [CommandName.TerminalInterrupt]: () => null,
    [CommandName.TerminalClose]: () => null,
    [CommandName.WorkspacesUpdate]: () => {
      throw new Error('not in these tests')
    },
    [CommandName.SettingsGet]: () => ({ settings: DEFAULT_SETTINGS }),
    [CommandName.SettingsUpdate]: () => ({ settings: DEFAULT_SETTINGS }),
    ...overrides,
  }
}

let log: MemoryLog

beforeEach(() => {
  log = createMemoryLog(LogScope.Ipc)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createDispatcher', () => {
  it('runs the command handler with the parsed request, waiting for async handlers', async () => {
    const get = vi.fn(() => Promise.resolve({ value: 'async' }))
    const dispatch = createDispatcher(handlers({ [CommandName.UiStateGet]: get }), REQUEST_SCHEMAS)

    await expect(dispatch('uiState.get', { key: 'active_workspace_id' })).resolves.toEqual({
      ok: true,
      value: { value: 'async' },
    })
    expect(get).toHaveBeenCalledWith({ key: UiStateKey.ActiveWorkspaceId })
  })

  it.each([undefined, 42, 'workspaces.delete'])('refuses the unknown command %j', async (command) => {
    const dispatch = createDispatcher(handlers(), REQUEST_SCHEMAS)

    await expect(dispatch(command, {})).resolves.toEqual({
      ok: false,
      error: bridgeError(BridgeErrorCode.UnknownCommand, `Unknown command ${String(command)}`),
    })
  })

  it('refuses an invalid request without running the handler', async () => {
    const set = vi.fn(() => null)
    const dispatch = createDispatcher(handlers({ [CommandName.UiStateSet]: set }), REQUEST_SCHEMAS)

    await expect(dispatch('uiState.set', { key: 'active_workspace_id' })).resolves.toEqual({
      ok: false,
      error: bridgeError(
        BridgeErrorCode.InvalidRequest,
        'uiState.set: value: Invalid input: expected string, received undefined',
      ),
    })
    expect(set).not.toHaveBeenCalled()
  })

  it('reports a handler that throws as an internal error, and logs it', async () => {
    const failure = new Error('disk full')
    const dispatch = createDispatcher(
      handlers({
        [CommandName.UiStateSet]: () => {
          throw failure
        },
      }),
      REQUEST_SCHEMAS,
      log.logger,
    )

    await expect(dispatch('uiState.set', { key: 'active_workspace_id', value: 'x' })).resolves.toEqual({
      ok: false,
      error: bridgeError(BridgeErrorCode.Internal, 'uiState.set failed: disk full'),
    })
    expect(log.withMessage('command threw')).toEqual([
      expect.objectContaining({ level: LogLevel.Error, fields: { command: 'uiState.set', error: failure } }),
    ])
  })

  it("reports a handler's command failure with its own code, without logging it", async () => {
    const dispatch = createDispatcher(
      handlers({
        [CommandName.TasksReopen]: () => {
          throw new CommandFailure(BridgeErrorCode.InvalidTransition, "Can't reopen a task that is active")
        },
      }),
      REQUEST_SCHEMAS,
      log.logger,
    )

    await expect(dispatch('tasks.reopen', { id: 't1' })).resolves.toEqual({
      ok: false,
      error: bridgeError(BridgeErrorCode.InvalidTransition, "tasks.reopen: Can't reopen a task that is active"),
    })
    expect(log.withMessage('command threw')).toEqual([])
  })

  it('reports a rejected handler, or one that throws a non-Error, as an internal error', async () => {
    const dispatch = createDispatcher(
      handlers({
        [CommandName.UiStateGet]: () => Promise.reject(new Error('gone')),
        [CommandName.WorkspacesList]: () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'bug'
        },
      }),
      REQUEST_SCHEMAS,
    )

    await expect(dispatch('uiState.get', { key: 'active_workspace_id' })).resolves.toEqual({
      ok: false,
      error: bridgeError(BridgeErrorCode.Internal, 'uiState.get failed: gone'),
    })
    await expect(dispatch('workspaces.list', {})).resolves.toEqual({
      ok: false,
      error: bridgeError(BridgeErrorCode.Internal, 'workspaces.list failed: bug'),
    })
  })
})

describe('createBroadcast', () => {
  it('sends each event to every target open at the time', () => {
    const first = { send: vi.fn() }
    const second = { send: vi.fn() }
    const targets = [first]
    const broadcast = createBroadcast('channel', () => targets)
    const event = { type: EventType.UiStateChanged, entry: { key: UiStateKey.ActiveWorkspaceId, value: 'w' } } as const

    broadcast(event)
    targets.push(second)
    broadcast(event)

    expect(first.send).toHaveBeenCalledTimes(2)
    expect(first.send).toHaveBeenCalledWith('channel', event)
    expect(second.send).toHaveBeenCalledOnce()
  })
})

describe('the command log', () => {
  it('logs each command at debug level: its name, its task, how long it took, and never its request', async () => {
    const dispatch = createDispatcher(handlers(), REQUEST_SCHEMAS, log.logger)

    await dispatch(CommandName.TasksSend, { id: 'task-1', text: 'my password is hunter2' })
    await dispatch(CommandName.QueueAdd, { taskId: 'task-2', text: 'Also the docs.' })
    await dispatch(CommandName.WorkspacesList, {})

    expect(log.records.map(({ level, scope, message, fields }) => ({ level, scope, message, fields }))).toEqual([
      {
        level: LogLevel.Debug,
        scope: LogScope.Ipc,
        message: 'command',
        fields: { command: 'tasks.send', taskId: 'task-1', durationMs: expect.any(Number) as unknown, ok: true },
      },
      {
        level: LogLevel.Debug,
        scope: LogScope.Ipc,
        message: 'command',
        fields: { command: 'queue.add', taskId: 'task-2', durationMs: expect.any(Number) as unknown, ok: true },
      },
      {
        level: LogLevel.Debug,
        scope: LogScope.Ipc,
        message: 'command',
        fields: { command: 'workspaces.list', durationMs: expect.any(Number) as unknown, ok: true },
      },
    ])
    expect(JSON.stringify(log.records)).not.toContain('hunter2')
  })

  it("logs the task a new task's command made, and an id that isn't a task's", async () => {
    const task = { id: 'task-new' } as Task
    const dispatch = createDispatcher(
      handlers({ [CommandName.TasksCreate]: () => ({ task }) }),
      REQUEST_SCHEMAS,
      log.logger,
    )

    await dispatch(CommandName.TasksCreate, { workspaceId: 'ws-1' })
    await dispatch(CommandName.QueueRemove, { id: 'queued-1' })

    expect(log.records.map(({ fields }) => fields)).toEqual([
      expect.objectContaining({ command: 'tasks.create', taskId: 'task-new' }),
      expect.objectContaining({ command: 'queue.remove', id: 'queued-1' }),
    ])
    expect(log.records[1]?.fields).not.toHaveProperty('taskId')
  })

  it('logs a failed command as a warning, with its code and why', async () => {
    const dispatch = createDispatcher(
      handlers({
        [CommandName.TasksReopen]: () => {
          throw new CommandFailure(BridgeErrorCode.InvalidTransition, "Can't reopen a task that is active")
        },
      }),
      REQUEST_SCHEMAS,
      log.logger,
    )

    await dispatch(CommandName.TasksReopen, { id: 't1' })
    await dispatch(CommandName.UiStateSet, { key: 'active_workspace_id' })
    await dispatch('tasks.explode', {})

    expect(log.records.map(({ level, message, fields }) => ({ level, message, fields }))).toEqual([
      {
        level: LogLevel.Warn,
        message: 'command failed',
        fields: {
          command: 'tasks.reopen',
          taskId: 't1',
          durationMs: expect.any(Number) as unknown,
          ok: false,
          code: BridgeErrorCode.InvalidTransition,
          error: "tasks.reopen: Can't reopen a task that is active",
        },
      },
      {
        level: LogLevel.Warn,
        message: 'command failed',
        fields: expect.objectContaining({ command: 'uiState.set', code: BridgeErrorCode.InvalidRequest }) as unknown,
      },
      { level: LogLevel.Warn, message: 'unknown command', fields: { command: 'tasks.explode' } },
    ])
  })

  it('logs nothing by default', async () => {
    const spies = (['debug', 'info', 'warn', 'error', 'log'] as const).map((level) => vi.spyOn(console, level))

    await createDispatcher(handlers(), REQUEST_SCHEMAS)(CommandName.WorkspacesList, {})

    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })
})

describe('commandTaskId', () => {
  it("finds a command's task in its request's taskId, a tasks command's id, or the task it answers with", () => {
    const failed = { ok: false, error: bridgeError(BridgeErrorCode.Internal, 'x') } as const
    expect(commandTaskId(CommandName.FilesRead, { taskId: 't1', path: 'a' })).toBe('t1')
    expect(commandTaskId(CommandName.TasksStop, { id: 't2' })).toBe('t2')
    expect(commandTaskId(CommandName.QueueEdit, { id: 'q1', text: 'x' })).toBeUndefined()
    expect(commandTaskId(CommandName.TasksCreate, {}, { ok: true, value: { task: { id: 't3' } } })).toBe('t3')
    expect(commandTaskId(CommandName.TasksCreate, {}, { ok: true, value: null })).toBeUndefined()
    expect(commandTaskId(CommandName.TasksCreate, 'junk', failed)).toBeUndefined()
    expect(commandTaskId(CommandName.TasksStop, { id: 7 })).toBeUndefined()
  })
})
