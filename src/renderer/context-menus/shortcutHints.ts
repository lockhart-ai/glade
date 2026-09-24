/**
 * The keys the context menus show beside their items, from `docs/keymap.md`. They're kept in this one table until the
 * keymap registry (P7-04), which makes every shortcut rebindable, replaces it with the current bindings.
 */
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

export const SHORTCUT_HINTS: Readonly<Record<ShortcutAction, string>> = {
  [ShortcutAction.Open]: '↵',
  [ShortcutAction.TogglePin]: '⌘⇧P',
  [ShortcutAction.Rename]: 'F2',
  [ShortcutAction.MarkUnread]: '⌘⇧U',
  [ShortcutAction.MarkDone]: '⌘⇧D',
  [ShortcutAction.Copy]: '⌘C',
  [ShortcutAction.CloseFileTab]: '⌘W',
  [ShortcutAction.OpenInEditor]: '⌘⇧E',
  [ShortcutAction.ClearTerminal]: '⌘K',
  [ShortcutAction.KillProcess]: '⌃C',
  [ShortcutAction.CloseTerminalTab]: '⌘W',
}
