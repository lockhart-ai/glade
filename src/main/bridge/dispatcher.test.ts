import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import { UiStateKey, type Task } from '../../shared/domain'
import { createBroadcast, createDispatcher } from './dispatcher'
import { CommandFailure } from './errors'
import type { Handlers } from './handlers'
import { REQUEST_SCHEMAS } from './requests'

function handlers(overrides: Partial<Handlers> = {}): Handlers {
  return {
    [CommandName.WorkspacesList]: () => ({ workspaces: [] }),
    [CommandName.TasksList]: () => ({ tasks: [] }),
    [CommandName.TasksCreate]: () => ({ task: {} as Task }),
    [CommandName.TasksMarkDone]: () => ({ task: {} as Task }),
    [CommandName.TasksReopen]: () => ({ task: {} as Task }),
    [CommandName.TasksUpdate]: () => ({ task: {} as Task }),
    [CommandName.UiStateGet]: () => Promise.resolve({ value: 'async' }),
    [CommandName.UiStateGetAll]: () => ({ entries: [] }),
    [CommandName.UiStateSet]: () => null,
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
