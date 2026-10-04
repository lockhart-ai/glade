# Keymap

macOS bindings; Ctrl replaces ⌘ elsewhere. Every shortcut is rebindable in Settings › Keyboard, and menus show the
current binding. The menu bar answers the keys of its items; the window listens for the rest. ![Keymap](design/screens/22-keymap.png)

| Area | Action | Keys |
|---|---|---|
| Global | New task | ⌘N |
| | Jump to task: focuses the task search, as Search tasks does; type a task's name and choose it | ⌘P |
| | Search tasks | ⌘F |
| | Broadcast to every active task: opens the Broadcast modal, which sends one message to them all | ⌘⇧B |
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
| | Tool calls · Files · Todos · Artifacts · Subagents · Watchers · Changes | ⌘⌥1 – ⌘⌥7 |
| | Close file tab (the window, when no tab has the focus) | ⌘W |
| | Open file in editor | ⌘⇧E |
| | Save file | ⌘S |
| Terminal | Focus terminal | ⌃` |
| | New terminal tab | ⌘T |
| | Next / previous tab | ⌃⇥ / ⌃⇧⇥ |
| | Clear | ⌘K |
| | Kill process | ⌃C |
| Menus and dialogs | Move / choose / close | ↑↓ / ↵ / Esc |
| | Select an answer in a question card | 1 – 9 |
| | Previous / next image in the image viewer, stopping at the first and last | ←→ |

## The Files tab's Browse tab

The tree and the search (#398, `design/screens/37-browse-files.png`) answer their own keys while they have the focus,
as menus do; they're fixed. In the tree, ↑↓ move, → opens a folder (or goes into an open one), ← closes an open folder
(or goes up to the folder a row is in), ↵ opens a file in a tab or opens or closes a folder, Home and End go to the
first and last rows, and ↑ on the top row goes back to the search. In the search, ↓ goes into the tree, or with a
search ↑↓ move through its results; ↵ opens the one picked, and Esc clears the search. Search tasks (⌘F, or whatever
you bind it to), with the focus in the Files tab while Browse shows, puts the focus in Browse's search instead of the
task search; in the editor, its own ⌘F finds in the file, and anywhere else ⌘F searches tasks as ever.

## The Todos tab as the todo hub

**Behind the hidden `todoHubEnabled` setting until #501** (P16, #491; `decisions.md`): with it off, the Todos tab has
no keys of its own beyond Tab and Context menu, as now.

With it on, the tab's todos answer their own keys while one has the focus (`design/screens/46-todo-hub.png`), as the
Browse tree does; they're fixed. On a todo, or on **Not under a todo**, ↑↓ move to the todo before or after it,
stopping at the first and last; → opens it, on the filter it was last on (nothing if it's open already, or has nothing
under it); ← closes it; ↵ or Space opens or closes it, as a click does; and Context menu (⇧F10) opens a todo's menu
(Copy · Ask agent about this). Held with ⌘, ⌃, ⌥ or ⇧, those keys are left to whatever command has them, so Next /
previous task (⌥↓ / ⌥↑) work from a todo too. Tab reaches every todo, then an open todo's filter pills and its tiles,
in order: ↵ or Space on a pill shows that kind alone, or all of them (All), and what ↵ does on a tile is each kind's
own (#498, #499). A closed todo's counts are skipped, since → opens the todo and its pills say the same.

On a **commit's tile**, ↵ or Space opens it in place to its branch and its files, and again closes it (#499). Tab then
goes on into its files, and ↵ on one opens it in the Files tab.

## Rebinding

The keymap lives in `src/shared/keymap.ts` (the commands themselves are in `src/shared/commands.ts`): one command per
row above, with its default binding, where it applies and who answers it. The menu bar answers its items' keys (main
builds its accelerators from the keymap, with the bindings the window reports in `menu.update`); the window's one key
dispatcher (`src/renderer/commands`) answers the rest, or the focused element does for its own keys. Settings › Keyboard
rebinds a shortcut by recording the keys you press; Reset puts back its default. Bindings you change are stored as the
`keyBindings` setting, and both the menu bar and the window follow them at once.

- **Where they apply:** the menu bar's and the window's shortcuts work wherever the focus is, typing in a text field
  included. Next / previous task (⌥↓ / ⌥↑) work anywhere but a text field, where they'd move the caret, with one
  exception: the input bar's message field, where they switch tasks too. Other text fields (search, rename, Settings, a
  question's text answer, a Deny note, a queued message being edited) keep them, and so does the terminal, which sends
  them to the shell. Each task's input bar keeps its draft while you're on another task, and across a relaunch.
  Selecting a task, by any of these routes or another (a click, a notification, search, a workspace switch, a dialog
  closing), focuses its input bar once it's shown, unless a modal is open; closing the modal then focuses it (#415).
- **Refused, with the reason under the row:** keys another command already has where both apply (the menu bar's and
  the window's shortcuts reach everywhere, Next / previous task's the message field too; the message field, menus,
  question cards and terminal each have their own keys); keys macOS or the app menu takes first (⌘Q, ⌘H, ⌘⌥H, ⌘M,
  ⌘⇥, ⌘⇧⇥, ⌘Space, the Edit menu's ⌘Z, ⌘⇧Z, ⌘X, ⌘C, ⌘V and ⌘A, and the View menu's ⌘0, ⌘+, ⌘=, ⌘- and ⌃⌘F); and,
  for a shortcut that works in text fields too, keys without ⌘, ⌃ or ⌥ (F-keys excepted).
- **Fixed:** New line (⇧↵), Close file tab (⌘W, the menu bar's Close, which closes the window when no tab has the
  focus), Kill process (⌃C, which the terminal sends to the shell), and the menus' and dialogs' Move, Choose, Close,
  question-card answers (1 – 9) and the image viewer's Previous / next image (← →).
- **Ranges:** Switch workspace (⌘1 – ⌘9) and the right panel's tabs (⌘⌥1 – ⌘⌥7) rebind their modifiers: press one of
  the digits with the modifiers to use.
