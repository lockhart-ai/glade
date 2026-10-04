/**
 * The app's settings (Settings, ⌘,; `docs/design/screens/21-settings.png`): what new tasks start with, what the agent
 * is asked to keep current, and how replies notify. Main stores them (`src/main/settings`) and is the only one that
 * acts on them; the renderer shows and changes them through the bridge. Each one saves as soon as it changes.
 */
import { Effort, PermissionMode } from './domain'
import type { KeyBindingOverrides } from './keymap'
import { DEFAULT_CONTROL_PORT } from './control'
import { BUILT_IN_MODELS } from './models'

export interface Settings {
  /** The model a new task starts with, as the SDK names it. Each task can change its own from its input bar. */
  readonly defaultModel: string
  /** The effort a new task starts with. */
  readonly defaultEffort: Effort
  /** The permission mode a new task starts with (Settings › Agent › Permissions). */
  readonly defaultPermissionMode: PermissionMode
  /** Whether the agent is asked to keep the task's one-line status current every turn (`set_status`). */
  readonly statusSummary: boolean
  /** Whether the agent is asked to name a new task from your first message (`set_title`). */
  readonly taskTitles: boolean
  /** Whether a reply in a task you aren't viewing sends a native notification. */
  readonly notifications: boolean
  /** Whether those notifications make a sound. */
  readonly notificationSound: boolean
  /** The shortcuts you've rebound in Settings › Keyboard (`keymap.ts`); the rest keep their defaults. */
  readonly keyBindings: KeyBindingOverrides
  /**
   * Whether other agents may drive Glade through its `glade-control` tools (Settings › Control, Let agents control
   * Glade; `docs/control-api.md`). Off, every call is refused, and new sessions don't get the tools.
   */
  readonly controlEnabled: boolean
  /**
   * The port the control API's HTTP endpoint listens on (Settings › Control), 1024–65535. When it's taken, the next nine
   * are tried (`./control`).
   */
  readonly controlPort: number
  /**
   * Whether Glade shows its icon in the macOS menu bar, with what's in flight and a popover listing it (Settings ›
   * General; `docs/design/html/29-menu-bar.html`).
   */
  readonly showInMenuBar: boolean
  /**
   * Whether every task's agent runs in the sandbox (Settings › Agent › Sandbox, #445): its commands under Seatbelt and
   * its file tools held to the same folders, with nothing granted beyond the workspace root. A session reads it as it
   * starts. Off, sessions run as they did before the sandbox.
   *
   * Off by default while P15 is being built: main is released from, and without the sandbox's permission cards
   * (P15-05) a sandboxed task could be granted access only from Settings (P15-06), never as it asks. The default flips
   * to on in P15's last PR (#452).
   */
  readonly sandboxEnabled: boolean
  /**
   * Whether the Todos tab is the todo hub (P16, #491): each todo with the files, links, subagents, watchers and commits
   * that belong to it (`./todoHub`). A hidden switch, with nothing in Settings: the phase is built behind it, and with
   * it off nothing of the hub is read, written, sent or shown, so the app behaves exactly as it did before. Off until
   * the phase's last issue (#501) turns it on and takes the switch away.
   */
  readonly todoHubEnabled: boolean
}

/** The settings you change at once: the ones left out keep their value. */
export type SettingsPatch = Partial<Settings>

/**
 * The settings before you change any: the SDK's default model (the built-in list's first) at high effort, allowing every tool
 * call, notifying silently, with no agent allowed to control Glade, showing Glade in the menu bar, and, until P15's
 * last PR (#452) turns it on, running agents outside the sandbox; and, until P16's last PR (#501), with the Todos tab as
 * it was before the todo hub.
 */
export const DEFAULT_SETTINGS: Settings = {
  defaultModel: BUILT_IN_MODELS[0].id,
  defaultEffort: Effort.High,
  defaultPermissionMode: PermissionMode.AllowAll,
  statusSummary: true,
  taskTitles: true,
  notifications: true,
  notificationSound: false,
  keyBindings: {},
  controlEnabled: false,
  controlPort: DEFAULT_CONTROL_PORT,
  showInMenuBar: true,
  // Off until P15's last PR (#452): see `Settings.sandboxEnabled`.
  sandboxEnabled: false,
  // Off until P16's last PR (#501): see `Settings.todoHubEnabled`.
  todoHubEnabled: false,
}
