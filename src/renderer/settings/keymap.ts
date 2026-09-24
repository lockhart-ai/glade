/**
 * The keymap, as Settings › Keyboard lists it: `docs/keymap.md`, laid out as `docs/design/screens/22-keymap.png` groups
 * it. Read-only for now. The command registry (P7-04) replaces this list with each command's current binding, which
 * Settings › Keyboard then lets you rebind.
 */

/** One action and its keys: each entry a keycap, e.g. `['⌥↓', '⌥↑']` for Next / previous task. */
export interface KeyBinding {
  readonly action: string
  readonly keys: readonly string[]
}

/** The bindings of one area of the app, e.g. Global or Chat. */
export interface KeymapGroup {
  readonly area: string
  readonly bindings: readonly KeyBinding[]
}

export const KEYMAP: readonly KeymapGroup[] = [
  {
    area: 'Global',
    bindings: [
      { action: 'New task', keys: ['⌘N'] },
      { action: 'Jump to task', keys: ['⌘P'] },
      { action: 'Search tasks', keys: ['⌘F'] },
      { action: 'Settings', keys: ['⌘,'] },
      { action: 'New workspace', keys: ['⌘⇧N'] },
      { action: 'Open folder as workspace', keys: ['⌘O'] },
      { action: 'Switch workspace', keys: ['⌘1 – ⌘9'] },
    ],
  },
  {
    area: 'Task list',
    bindings: [
      { action: 'Next / previous task', keys: ['⌥↓', '⌥↑'] },
      { action: 'Next task that needs you', keys: ['⌘⌥↓'] },
      { action: 'Rename', keys: ['F2'] },
      { action: 'Pin / unpin', keys: ['⌘⇧P'] },
      { action: 'Mark as unread', keys: ['⌘⇧U'] },
      { action: 'Mark done', keys: ['⌘⇧D'] },
      { action: 'Context menu', keys: ['⇧F10'] },
    ],
  },
  {
    area: 'Chat',
    bindings: [
      { action: 'Send (queues while working)', keys: ['↵'] },
      { action: 'New line', keys: ['⇧↵'] },
      { action: 'Stop the agent', keys: ['⌘.'] },
      { action: 'Compact context', keys: ['⌘⇧K'] },
      { action: 'Edit last queued message', keys: ['↑'] },
      { action: 'Focus input', keys: ['⌘L'] },
    ],
  },
  {
    area: 'Panels',
    bindings: [
      { action: 'Toggle task list', keys: ['⌘B'] },
      { action: 'Toggle right panel', keys: ['⌘⌥B'] },
      { action: 'Toggle bottom bar', keys: ['⌘J'] },
      { action: 'Tool calls · Files · Todos', keys: ['⌘⌥1–3'] },
      { action: 'Artifacts · Subagents', keys: ['⌘⌥4–5'] },
      { action: 'Close file tab', keys: ['⌘W'] },
      { action: 'Open file in editor', keys: ['⌘⇧E'] },
    ],
  },
  {
    area: 'Terminal',
    bindings: [
      { action: 'Focus terminal', keys: ['⌃`'] },
      { action: 'New terminal tab', keys: ['⌘T'] },
      { action: 'Next / previous tab', keys: ['⌃⇥', '⌃⇧⇥'] },
      { action: 'Clear', keys: ['⌘K'] },
      { action: 'Kill process', keys: ['⌃C'] },
    ],
  },
  {
    area: 'Menus and dialogs',
    bindings: [
      { action: 'Move', keys: ['↑↓'] },
      { action: 'Choose', keys: ['↵'] },
      { action: 'Close', keys: ['Esc'] },
      { action: 'Select an answer in a question card', keys: ['1 – 9'] },
    ],
  },
]
