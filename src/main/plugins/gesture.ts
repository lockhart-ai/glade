/**
 * Whether you've just clicked or pressed a key in a plugin's view: what lets it open a task (`openTask`,
 * `docs/plugin-api.md`). The input is what Electron routes to the view's page from the OS, heard in main
 * (`./electron-view`), never anything the page says: a page can't make Electron see input it didn't get, so it can't
 * fake a click. One click or key press allows one `openTask`, within `PLUGIN_GESTURE_MS` of it.
 */

/** How long after a click or key press in its view a plugin may open a task. */
export const PLUGIN_GESTURE_MS = 1000

/** The input in a plugin's view that counts. */
export enum PluginInputKind {
  /** A mouse button or a key goes down: a new gesture. */
  Press = 'press',
  /** A mouse button comes up: the same click, so it's timed from here (a click's handler runs on release). */
  Release = 'release',
}

/** A plugin view's last click or key press, which one `openTask` may use. */
export interface PluginGesture {
  /** Real input arrived in the view. */
  input(kind: PluginInputKind): void
  /** Whether there's an unused gesture from the last `PLUGIN_GESTURE_MS`; if there is, it's used up. */
  take(): boolean
}

export function createPluginGesture(now: () => number): PluginGesture {
  /** When the last gesture was, while it's unused. */
  let at: number | null = null
  return {
    input(kind) {
      switch (kind) {
        case PluginInputKind.Press:
          at = now()
          return
        case PluginInputKind.Release:
          // Only the press's own release: a release after the gesture was used (or with none) starts nothing.
          if (at !== null) at = now()
          return
      }
    },
    take() {
      const last = at
      at = null
      return last !== null && now() - last <= PLUGIN_GESTURE_MS
    },
  }
}
