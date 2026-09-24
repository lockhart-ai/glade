import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import {
  FileContentKind,
  FileInfoKind,
  UiStateKey,
  type Message,
  type OpenFiles,
  type QuestionSet,
  type QueuedMessage,
  type Task,
} from '../../shared/domain'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { createBroadcast, createDispatcher } from './dispatcher'
import { CommandFailure } from './errors'
import type { TerminalTab } from '../../shared/terminal'
import type { Handlers } from './handlers'
import { REQUEST_SCHEMAS } from './requests'

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
      openFiles: { taskId: 't', paths: [], activePath: null },
      todos: null,
      artifacts: [],
    }),
    [CommandName.QueueAdd]: () => ({ queuedMessage: {} as QueuedMessage }),
    [CommandName.QueueEdit]: () => ({ queuedMessage: {} as QueuedMessage }),
    [CommandName.QueueRemove]: () => null,
    [CommandName.QuestionsAnswer]: () => ({ questionSet: {} as QuestionSet }),
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

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
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
    )

    await expect(dispatch('uiState.set', { key: 'active_workspace_id', value: 'x' })).resolves.toEqual({
      ok: false,
      error: bridgeError(BridgeErrorCode.Internal, 'uiState.set failed: disk full'),
    })
    expect(console.error).toHaveBeenCalledWith('Command uiState.set failed', failure)
  })

  it("reports a handler's command failure with its own code, without logging it", async () => {
    const dispatch = createDispatcher(
      handlers({
        [CommandName.TasksReopen]: () => {
          throw new CommandFailure(BridgeErrorCode.InvalidTransition, "Can't reopen a task that is active")
        },
      }),
      REQUEST_SCHEMAS,
    )

    await expect(dispatch('tasks.reopen', { id: 't1' })).resolves.toEqual({
      ok: false,
      error: bridgeError(BridgeErrorCode.InvalidTransition, "tasks.reopen: Can't reopen a task that is active"),
    })
    expect(console.error).not.toHaveBeenCalled()
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
