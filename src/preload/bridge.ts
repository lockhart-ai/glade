import {
  COMMAND_CHANNEL,
  EVENT_CHANNEL,
  type BridgeResult,
  type EventListener,
  type GladeBridge,
  type GladeEvent,
} from '../shared/bridge'

/** The part of Electron's `ipcRenderer` the bridge uses, so tests can stand in a fake. */
export interface RendererIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: IpcListener): unknown
  removeListener(channel: string, listener: IpcListener): unknown
}

export type IpcListener = (event: unknown, ...args: unknown[]) => void

/**
 * Builds `window.glade` on top of `ipcRenderer`. Commands go out on one channel and events come in on another; the
 * renderer never sees the IPC event object, only the typed payloads.
 */
export function createBridge(ipc: RendererIpc): GladeBridge {
  return {
    async invoke(command, request) {
      // Main answers every command on this channel with a `BridgeResult` for that command's response.
      const result = (await ipc.invoke(COMMAND_CHANNEL, command, request)) as BridgeResult<never>
      if (result.ok) return result.value
      // A plain object, not an Error: `contextBridge` would drop an Error's `code` (see `BridgeError`).
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw result.error
    },

    subscribe(listener: EventListener) {
      const onEvent: IpcListener = (_event, payload) => {
        // Main only sends `GladeEvent`s on this channel.
        listener(payload as GladeEvent)
      }
      ipc.on(EVENT_CHANNEL, onEvent)
      return () => {
        ipc.removeListener(EVENT_CHANNEL, onEvent)
      }
    },
  }
}
