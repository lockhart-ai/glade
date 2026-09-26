# Design

Screens are 1920×1200 at 1× (the lifecycle board and the menu bar are 1440×900; the interaction map is 3200×1720).
Sample data is illustrative. Tokens are in `tokens.md`; exact markup per screen in `html/`.

| Screen | What it shows | |
|---|---|---|
| Task workspace | The main window: sidebar, task card with header, chat and right panel, bottom bar. Done section collapsed. | ![Task workspace](screens/task-workspace.png) |
| Task lifecycle | Active ⇄ Done and the task record. | ![Task lifecycle](screens/lifecycle.png) |
| 1 · New task | An empty task; the first message sets the title and objective. | ![1 · New task](screens/01-new-task.png) |
| 2 · Agent working | Live working line, Stop, message queue above the input, pasted images above the text, context meter. | ![2 · Agent working](screens/02-agent-working.png) |
| 3 · Rich question | The `ask` card: option cards with sketches, pills, Send answers. | ![3 · Rich question](screens/03-rich-question.png) |
| 4 · Needs you | Unread row in the sidebar and a native notification from another task. | ![4 · Needs you](screens/04-needs-you.png) |
| 5 · Mark done | No dialog; Undo toast; the task moves to Done with its outcome. | ![5 · Mark done](screens/05-mark-done.png) |
| 6 · Reopen by chatting | A message in a done task reopens it, with dividers in chat and log. | ![6 · Reopen by chatting](screens/06-reopen.png) |
| 7 · Search | Results across titles, objectives, outcomes and chat logs; matches highlighted. | ![7 · Search](screens/07-search.png) |
| 8 · Open a file | Files tab with open-file tabs, source/preview toggle; the drag handles that resize the sidebar, right panel and bottom bar. | ![8 · Open a file](screens/08-open-file.png) |
| 9 · Todos | The agent's checklist with progress, and each task's progress on its sidebar row's third line (a ring and `3/7`; a check once all are done), which shows only while a task has something on it. | ![9 · Todos](screens/09-todos.png) |
| 10 · Artifacts | Deliverables with Open / Copy / Reveal. | ![10 · Artifacts](screens/10-artifacts.png) |
| 11 · Subagents | Status and latest line per subagent; one expanded inline to its log. The running ones' count on the task's sidebar row, on its third line. | ![11 · Subagents](screens/11-subagents.png) |
| 12 · Right-click a task | Task context menu in place. ("Reveal folder in Finder" was removed; see `../context-menus.md`.) | ![12 · Right-click a task](screens/12-right-click-task.png) |
| 13 · Context menus | Every context menu. `../context-menus.md` is authoritative ("Reveal folder in Finder" was removed). | ![13 · Context menus](screens/13-context-menus.png) |
| 14 · Workspace switcher | Sidebar dropdown with per-workspace counts. | ![14 · Workspace switcher](screens/14-workspace-switcher.png) |
| 15 · Workspace menu | The macOS menu bar's Workspace menu. | ![15 · Workspace menu](screens/15-workspace-menu.png) |
| 16 · Error in a task | Agent stopped after retries; Retry / Retry with another model / Show details. | ![16 · Error in a task](screens/16-error.png) |
| 17 · Usage limit or offline | App-wide banner; tasks pause and resume on their own. | ![17 · Usage limit or offline](screens/17-usage-limit.png) |
| 18 · Relaunch after a crash | Mid-turn tasks resume; notice and dividers. | ![18 · Relaunch after a crash](screens/18-relaunch.png) |
| 19 · Compaction | Context popover at 97%, Compact now. (The "notes saved to CLAUDE.md" line is superseded: Glade doesn't manage notes.) | ![19 · Compaction](screens/19-compaction.png) |
| 20 · First run | No workspace yet: Open folder / Create a new folder. | ![20 · First run](screens/20-first-run.png) |
| 21 · Settings | Modal; Agent section shown. Model lists the models the SDK offers; Effort offers the default model's own levels (Extra high among them), and hides for a model with none. | ![21 · Settings](screens/21-settings.png) |
| 21 · Settings › Plugins | Plugins section: the plugins folder, one row per plugin with its toggle, an invalid one with its reason. | ![21 · Settings › Plugins](screens/21-settings-plugins.png) |
| 21 · Settings › Control | Control section: Let agents control Glade on, the endpoint, the `claude mcp add` command with Copy, Regenerate token, the port with its fallback notice, and the note on Glade's own tasks. | ![21 · Settings › Control](screens/21-settings-control.png) |
| 22 · Keymap | Every shortcut. Also in `../keymap.md`. | ![22 · Keymap](screens/22-keymap.png) |
| 23 · Permission card | Ask before edits and commands: a Bash call waiting on you with Allow once, Allow for this task (its command prefix) and Deny, and a subagent's Edit with Deny's note field open; cards collapsed to one line once allowed once or denied (with the note). Built from the question card; no original design. | ![23 · Permission card](screens/23-permission-card.png) |
| 24 · Permissions picker | The input bar's Permissions picker open on Allow all and Ask before edits and commands, over an open Bash card; above it, cards collapsed to one line once allowed once, allowed for this task or withdrawn. | ![24 · Permissions picker](screens/24-permissions-picker.png) |
| 25 · Backfilled | A done task backfilled through the control API (P13-04): the Backfilled card at the top of the chat, expanded to its handoff note (rendered Markdown), with the date it was added; the files the backfill registered in the Artifacts tab. Built from the chat's cards; no original design. | ![25 · Backfilled](screens/25-backfilled.png) |
| 26 · Backfilled, collapsed | The same task reopened by a message: the card collapsed to its one line above the conversation. | ![26 · Backfilled, collapsed](screens/26-backfilled-collapsed.png) |
| 27 · Tab overflow | The right panel at its narrowest, too narrow for its tabs: the row scrolls sideways (wheel, trackpad or chevron) with no scroll bar. Here it's scrolled to the end to show the selected Subagents, with a chevron over a fade at the left end; the same shows at the right end while tabs are past it. Built from 11 · Subagents; no original design. | ![27 · Tab overflow](screens/27-tab-overflow.png) |
<<<<<<< HEAD
| 28 · Watchers | The Watchers tab: what the agent left running or scheduled (Monitor watches, background commands, wakeups, cron jobs), each with its state, what it runs, its last output, how many times it woke the agent and when, and Stop while it is live; the count of live ones on the tab. The eye and count on a sidebar row's third line, after any todo progress and running subagents: a task with live watchers, done or not. Built from the Subagents tab; no original design. | ![28 · Watchers](screens/28-watchers.png) |
=======
| 28 · Watchers | The Watchers tab: what the agent left running or scheduled (Monitor watches, background commands, wakeups, cron jobs), each with its state, what it runs, its last output, how many times it woke the agent and when, and Stop while it is live; the count of live ones on the tab. The eye and count on a sidebar row: a task with live watchers, done or not. Built from the Subagents tab; no original design. | ![28 · Watchers](screens/28-watchers.png) |
| 29 · Menu bar | Glade's icon in the macOS menu bar (1440×900): a monochrome template glyph on dark and light bars, idle, pulsing while an agent works (its frames), with the count of tasks that need you, and highlighted while open; its popover under it, with Needs you (task, workspace and why), Working (status line, todo progress and bar, elapsed) and Recent (the last notifications, with their age), and Open Glade and Quit; and the popover with nothing in flight. | ![29 · Menu bar](screens/29-menu-bar.png) |
>>>>>>> origin/main
| Interaction map | Every screen, state and action as a graph. | ![Interaction map](screens/interaction-map.png) |
| Decisions | The decisions board. | ![Decisions](screens/decisions.png) |
| Icon exploration | Variations of the chosen icon; W07 is the one. | ![Icon exploration](screens/icon-exploration.png) |

## Icon

`../../assets/icon/glade-icon.svg` (app tile), `glade-mark.svg` (mark only), and 1024/256 PNGs.
