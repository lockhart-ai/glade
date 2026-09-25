import { useMemo } from 'react'
import { AppCommandId, TaskCommandId, WindowCommandId } from '../../shared/commands'
import { DEFAULT_KEYMAP, formatBinding, type Keymap, type ShortcutId } from '../../shared/keymap'
import { useKeymap } from '../commands/hooks'

/** The keys the context menus show beside their items. */
export enum ShortcutAction {
  /** Opens what the focused row is: a task, or a subagent's log. */
  Open = 'open',
  TogglePin = 'toggle_pin',
  Rename = 'rename',
  MarkUnread = 'mark_unread',
  MarkDone = 'mark_done',
  Copy = 'copy',
  CloseFileTab = 'close_file_tab',
  OpenInEditor = 'open_in_editor',
  ClearTerminal = 'clear_terminal',
  KillProcess = 'kill_process',
  CloseTerminalTab = 'close_terminal_tab',
}

/** The command whose binding each hint shows. Copy is the Edit menu's ⌘C, which no command has. */
const HINT_COMMANDS: Readonly<Record<Exclude<ShortcutAction, ShortcutAction.Copy>, ShortcutId>> = {
  [ShortcutAction.Open]: WindowCommandId.MenuChoose,
  [ShortcutAction.TogglePin]: TaskCommandId.TogglePin,
  [ShortcutAction.Rename]: TaskCommandId.Rename,
  [ShortcutAction.MarkUnread]: TaskCommandId.MarkUnread,
  [ShortcutAction.MarkDone]: TaskCommandId.MarkDone,
  [ShortcutAction.CloseFileTab]: AppCommandId.Close,
  [ShortcutAction.OpenInEditor]: WindowCommandId.OpenInEditor,
  [ShortcutAction.ClearTerminal]: WindowCommandId.ClearTerminal,
  [ShortcutAction.KillProcess]: WindowCommandId.KillProcess,
  [ShortcutAction.CloseTerminalTab]: AppCommandId.Close,
}

/** What each hint shows. */
export type ShortcutHints = Readonly<Record<ShortcutAction, string>>

/** The hints for a keymap: each command's current binding, so a shortcut you've rebound shows as you bound it. */
export function shortcutHints(keymap: Keymap): ShortcutHints {
  const hints = Object.fromEntries(
    Object.entries(HINT_COMMANDS).map(([action, id]) => [action, formatBinding(id, keymap)]),
  ) as Record<Exclude<ShortcutAction, ShortcutAction.Copy>, string>
  return { ...hints, [ShortcutAction.Copy]: '⌘C' }
}

/** The hints with every shortcut at its default. */
export const SHORTCUT_HINTS: ShortcutHints = shortcutHints(DEFAULT_KEYMAP)

/** The hints for the keymap as it now is. */
export function useShortcutHints(): ShortcutHints {
  const keymap = useKeymap()
  return useMemo(() => shortcutHints(keymap), [keymap])
}
