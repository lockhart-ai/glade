/**
 * The app's settings (Settings, ⌘,; `docs/design/screens/21-settings.png`): what new tasks start with, what the agent
 * is asked to keep current, and how replies notify. Main stores them (`src/main/settings`) and is the only one that
 * acts on them; the renderer shows and changes them through the bridge. Each one saves as soon as it changes.
 */
import { Effort, PermissionMode } from './domain'
import type { KeyBindingOverrides } from './keymap'
import { MODEL_OPTIONS } from './models'

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
}

/** The settings you change at once: the ones left out keep their value. */
export type SettingsPatch = Partial<Settings>

/**
 * The settings before you change any: the SDK's default model (the picker's first) at high effort, allowing every tool
 * call, notifying silently.
 */
export const DEFAULT_SETTINGS: Settings = {
  defaultModel: MODEL_OPTIONS[0].id,
  defaultEffort: Effort.High,
  defaultPermissionMode: PermissionMode.AllowAll,
  statusSummary: true,
  taskTitles: true,
  notifications: true,
  notificationSound: false,
  keyBindings: {},
}
