import { AppCommandId, commandHint, TaskCommandId } from '../../shared/commands'

/**
 * The keys the context menus show beside their items, from `docs/keymap.md`: the ones the menu bar answers come from
 * its keymap (`KEYMAP`), so the two always agree. The keymap registry (P7-04), which makes every shortcut rebindable,
 * grows that keymap to cover the rest.
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
}

export const SHORTCUT_HINTS: Readonly<Record<ShortcutAction, string>> = {
  [ShortcutAction.Open]: '↵',
  [ShortcutAction.TogglePin]: commandHint(TaskCommandId.TogglePin),
  [ShortcutAction.Rename]: commandHint(TaskCommandId.Rename),
  [ShortcutAction.MarkUnread]: commandHint(TaskCommandId.MarkUnread),
  [ShortcutAction.MarkDone]: commandHint(TaskCommandId.MarkDone),
  [ShortcutAction.Copy]: '⌘C',
  [ShortcutAction.CloseFileTab]: commandHint(AppCommandId.Close),
  [ShortcutAction.OpenInEditor]: '⌘⇧E',
}
