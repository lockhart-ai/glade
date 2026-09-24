// Test helper: Electron's IPC pair, in memory, so the bridge can be tested end to end without Electron.
import type { IpcListener, RendererIpc } from '../../preload/bridge'
import type { EventTarget } from './dispatcher'
import type { MainIpc } from '.'

type MainListener = (event: unknown, ...args: unknown[]) => unknown

export interface FakeIpcPair {
  readonly main: MainIpc
  readonly renderer: RendererIpc
  /** The window's `webContents`, which main sends events to. */
  readonly window: EventTarget
}

/** `ipcMain.handle`/`ipcRenderer.invoke` and `webContents.send`/`ipcRenderer.on`, wired to each other in memory. */
export function fakeIpcPair(): FakeIpcPair {
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
