# Keymap

macOS bindings; Ctrl replaces ⌘ elsewhere. Every shortcut is rebindable in Settings › Keyboard, and menus show the
current binding. The menu bar answers the keys of its items (`KEYMAP` in `src/shared/commands.ts`); the window listens
for the rest. ![Keymap](design/screens/22-keymap.png)

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
| | Close the focused file or terminal tab, else the window | ⌘W |
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
| | Open file in editor | ⌘⇧E |
| Terminal | Focus terminal | ⌃` |
| | New terminal tab | ⌘T |
| | Next / previous tab | ⌃⇥ / ⌃⇧⇥ |
| | Clear | ⌘K |
| | Kill process | ⌃C |
| Menus and dialogs | Move / choose / close | ↑↓ / ↵ / Esc |
| | Select an answer in a question card | 1 – 9 |
