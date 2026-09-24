# Keymap

macOS bindings; Ctrl replaces ⌘ elsewhere. Every shortcut is rebindable in Settings › Keyboard, and menus show the
current binding. The menu bar answers the keys of its items; the window listens for the rest. ![Keymap](design/screens/22-keymap.png)

| Area | Action | Keys |
|---|---|---|
| Global | New task | ⌘N |
| | Jump to task | ⌘P |
| | Search tasks | ⌘F |
| | Settings | ⌘, |
| | New workspace | ⌘⇧N |
| | Open folder as workspace | ⌘O |
| | Switch workspace | ⌘1 – ⌘9 |
| | Close workspace | ⌘⇧W |
| Task list | Next / previous task | ⌥↓ / ⌥↑ |
| | Next task that needs you | ⌘⌥↓ |
| | Rename | F2 |
| | Pin / unpin | ⌘⇧P |
| | Mark as unread | ⌘⇧U |
| | Mark done | ⌘⇧D |
| | Context menu | ⇧F10 |
| Chat | Send (queues while working) | ↵ |
| | New line | ⇧↵ |
| | Stop the agent | ⌘. |
| | Compact context | ⌘⇧K |
| | Edit last queued message | ↑ |
| | Focus input | ⌘L |
| Panels | Toggle task list | ⌘B |
| | Toggle right panel | ⌘⌥B |
| | Toggle bottom bar | ⌘J |
| | Tool calls · Files · Todos · Artifacts · Subagents | ⌘⌥1 – ⌘⌥5 |
| | Close file tab (the window, when no tab has the focus) | ⌘W |
| | Open file in editor | ⌘⇧E |
| Terminal | Focus terminal | ⌃` |
| | New terminal tab | ⌘T |
| | Next / previous tab | ⌃⇥ / ⌃⇧⇥ |
| | Clear | ⌘K |
| | Kill process | ⌃C |
| Menus and dialogs | Move / choose / close | ↑↓ / ↵ / Esc |
| | Select an answer in a question card | 1 – 9 |

## Rebinding

The keymap lives in `src/shared/keymap.ts` (the commands themselves are in `src/shared/commands.ts`): one command per
row above, with its default binding, where it applies and who answers it. The menu bar answers its items' keys (main
builds its accelerators from the keymap, with the bindings the window reports in `menu.update`); the window's one key
dispatcher (`src/renderer/commands`) answers the rest, or the focused element does for its own keys. Settings › Keyboard
rebinds a shortcut by recording the keys you press; Reset puts back its default. Bindings you change are stored as the
`keyBindings` setting, and both the menu bar and the window follow them at once.

- **Refused, with the reason under the row:** keys another command already has where both apply (the menu bar's and
  the window's shortcuts reach everywhere; the message field, menus, question cards and terminal each have their own
  keys); keys macOS or the app menu takes first (⌘Q, ⌘H, ⌘⌥H, ⌘M, ⌘Tab, ⌘⇧Tab, ⌘Space, the Edit menu's ⌘Z, ⌘⇧Z,
  ⌘X, ⌘C, ⌘V and ⌘A, and the View menu's ⌘0, ⌘+, ⌘=, ⌘- and ⌃⌘F); and, for a shortcut that works in text fields too,
  keys without ⌘, ⌃ or ⌥ (F-keys excepted).
- **Fixed:** New line (⇧↵), Close file tab (⌘W, the menu bar's Close, which closes the window when no tab has the
  focus), Kill process (⌃C, which the terminal sends to the shell), and the menus' and dialogs' Move, Choose, Close and
  question-card answers (1 – 9).
- **Ranges:** Switch workspace (⌘1 – ⌘9) and the right panel's tabs (⌘⌥1 – ⌘⌥5) rebind their modifiers: press one of
  the digits with the modifiers to use.
