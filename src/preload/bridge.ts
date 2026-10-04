import {
  COMMAND_CHANNEL,
  EVENT_BATCH,
  EVENT_CHANNEL,
  type BatchListener,
  type BridgeResult,
  type EventListener,
  type GladeBridge,
  type WindowEvent,
} from '../shared/bridge'

/** The part of Electron's `ipcRenderer` the bridge uses, so tests can stand in a fake. */
export interface RendererIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: IpcListener): unknown
  removeListener(channel: string, listener: IpcListener): unknown
}

export type IpcListener = (event: unknown, ...args: unknown[]) => void

/**
 * The path on disk of a file dropped or pasted into the window: Electron's `webUtils.getPathForFile`, `''` for one that
 * isn't a file on disk. Only the preload can ask; the page gets the path as text, never the file system.
 */
export type PathForFile = (file: File) => string

/** Tests that never drop or paste a file stand this in: no file is on disk. */
export const NO_FILE_PATHS: PathForFile = () => ''

/**
 * Builds `window.glade` on top of `ipcRenderer`. Commands go out on one channel and events come in on another; the
 * renderer never sees the IPC event object, only the typed payloads. `pathForFile` names a dropped or pasted file's path
 * on disk (`webUtils.getPathForFile` in the window), and `homeFolder` is the home folder main named to the window.
 */
export function createBridge(
  ipc: RendererIpc,
  pathForFile: PathForFile = NO_FILE_PATHS,
  homeFolder: string | null = null,
): GladeBridge {
  return {
    homeFolder,

    async invoke(command, request) {
      // Main answers every command on this channel with a `BridgeResult` for that command's response.
      const result = (await ipc.invoke(COMMAND_CHANNEL, command, request)) as BridgeResult<never>
      if (result.ok) return result.value
      // A plain object, not an Error: `contextBridge` would drop an Error's `code` (see `BridgeError`).
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw result.error
    },

    subscribe(listener: EventListener, batchListener?: BatchListener) {
      const onEvent: IpcListener = (_event, payload) => {
        // Main only sends `GladeEvent`s, and batches of them, on this channel.
        const event = payload as WindowEvent
        if (event.type !== EVENT_BATCH) listener(event)
        else if (batchListener !== undefined) batchListener(event.events)
        else for (const batched of event.events) listener(batched)
      }
      ipc.on(EVENT_CHANNEL, onEvent)
      return () => {
        ipc.removeListener(EVENT_CHANNEL, onEvent)
      }
    },

    pathForFile(file) {
      return pathForFile(file)
    },
  }
}
