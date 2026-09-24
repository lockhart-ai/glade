// The bridge end to end: the preload's `window.glade` over a fake IPC pair standing in for Electron's, against the real
// main-side registry, handlers and repositories on a temporary database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge, type IpcListener, type RendererIpc } from '../../preload/bridge'
import {
  bridgeError,
  BridgeErrorCode,
  CommandName,
  EventType,
  type GladeBridge,
  type GladeEvent,
} from '../../shared/bridge'
import { UiStateKey } from '../../shared/domain'
import { getUiState } from '../db/repositories/ui-state'
import { openTestDatabase, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { registerBridge, type MainIpc } from '.'
import type { EventTarget } from './dispatcher'

type MainListener = (event: unknown, ...args: unknown[]) => unknown

/** `ipcMain.handle`/`ipcRenderer.invoke` and `webContents.send`/`ipcRenderer.on`, wired to each other in memory. */
function fakeIpcPair(): { main: MainIpc; renderer: RendererIpc; window: EventTarget } {
  const handlers = new Map<string, MainListener>()
  const listeners = new Map<string, Set<IpcListener>>()
  const ipcEvent = { sender: 'renderer' }
  const listenersOn = (channel: string): Set<IpcListener> => {
    const set = listeners.get(channel) ?? new Set()
    listeners.set(channel, set)
    return set
  }
  // IPC copies every payload with the structured clone algorithm; so does the fake.
  return {
    main: {
      handle(channel, listener) {
        handlers.set(channel, listener)
      },
    },
    renderer: {
      async invoke(channel, ...args) {
        const handler = handlers.get(channel)
        if (handler === undefined) throw new Error(`No handler for ${channel}`)
        return structuredClone(await handler(ipcEvent, ...structuredClone(args)))
      },
      on(channel, listener) {
        listenersOn(channel).add(listener)
      },
      removeListener(channel, listener) {
        listenersOn(channel).delete(listener)
      },
    },
    window: {
      send(channel, event) {
        for (const listener of listenersOn(channel)) listener(ipcEvent, structuredClone(event))
      },
    },
  }
}

let database: TestDatabase
let glade: GladeBridge

beforeEach(() => {
  database = openTestDatabase()
  const ipc = fakeIpcPair()
  registerBridge({ ipc: ipc.main, db: database.db, targets: () => [ipc.window] })
  glade = createBridge(ipc.renderer)
})

afterEach(() => {
  database.close()
})

describe('the bridge', () => {
  it('sets UI state in the database and delivers the uiState.changed event to the renderer', async () => {
    const events: GladeEvent[] = []
    glade.subscribe((event) => events.push(event))
    const entry = { key: UiStateKey.ActiveWorkspaceId, value: 'workspace-1' }

    await expect(glade.invoke(CommandName.UiStateSet, entry)).resolves.toBeNull()

    expect(getUiState(database.db, UiStateKey.ActiveWorkspaceId)).toBe('workspace-1')
    expect(events).toEqual([{ type: EventType.UiStateChanged, entry }])
    await expect(glade.invoke(CommandName.UiStateGet, { key: UiStateKey.ActiveWorkspaceId })).resolves.toEqual({
      value: 'workspace-1',
    })
  })

  it('stops delivering events once unsubscribed', async () => {
    const listener = vi.fn()
    const unsubscribe = glade.subscribe(listener)
    unsubscribe()
    unsubscribe()

    await glade.invoke(CommandName.UiStateSet, { key: UiStateKey.ActiveWorkspaceId, value: 'workspace-1' })

    expect(listener).not.toHaveBeenCalled()
  })

  it('gets null for UI state that was never set', async () => {
    await expect(glade.invoke(CommandName.UiStateGet, { key: UiStateKey.ActiveWorkspaceId })).resolves.toEqual({
      value: null,
    })
  })

  it('lists the workspaces', async () => {
    const workspace = sampleWorkspace(database.db)

    await expect(glade.invoke(CommandName.WorkspacesList, {})).resolves.toEqual({ workspaces: [workspace] })
  })

  it('rejects an invalid request with a typed error, leaving the database alone', async () => {
    const events: GladeEvent[] = []
    glade.subscribe((event) => events.push(event))
    // Bypass the types, as a compromised or buggy renderer could.
    const request = { key: 'no_such_key', value: 1 } as never

    await expect(glade.invoke(CommandName.UiStateSet, request)).rejects.toEqual(
      bridgeError(BridgeErrorCode.InvalidRequest, 'uiState.set: key: expected a UI state key'),
    )
    expect(events).toEqual([])
    expect(database.db.prepare('SELECT COUNT(*) FROM ui_state').pluck().get()).toBe(0)
  })

  it('rejects an unknown command with a typed error', async () => {
    await expect(glade.invoke('tasks.explode' as CommandName, {})).rejects.toEqual(
      bridgeError(BridgeErrorCode.UnknownCommand, 'Unknown command tasks.explode'),
    )
  })
})
