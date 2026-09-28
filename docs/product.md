# Glade — product overview

![Task workspace](design/screens/task-workspace.png)

## Concepts

**Workspace.** The top level: a name and a root folder. Every task's agent runs in the workspace root, so the root's
`CLAUDE.md` (your conventions and personal context) applies to every task. Task records live only in the app's SQLite
database. How tasks organise files on disk (a folder per task, worktrees inside it) is a convention written in that
`CLAUDE.md`, not something Glade enforces; Glade seeds a starter `CLAUDE.md` for a new workspace that has none. You can
have several workspaces and switch between them from the sidebar or the menu bar (⌘1–9). Close workspace (⌘⇧W) shows
the most recently opened other workspace, or the welcome screen when there's none; the workspace stays in the list,
with its terminal tabs and their shells still running.
Remove from list… asks first, then forgets the workspace and deletes its tasks from Glade; its folder is never touched.

**Task.** One agent session with one objective. A task has exactly two states:

- **Active** — created the moment you send the first message. Whether the agent is mid-turn, waiting on you, asking a
  question or stopped by an error is shown in the conversation and by the status dot; it is not a separate state.
- **Done** — you mark it done (no dialog; an Undo toast appears). The latest status becomes its **outcome**. A done task
  stays open to chat: sending a message reopens it.

There are no follow-up tasks. One task can refer to another through its folder on disk.

![Lifecycle](design/screens/lifecycle.png)

**The task record.**

| Field | How it changes |
|---|---|
| Title | Set by the agent from your first message (`set_title`). You can rename it. |
| Objective | Set once by the agent from your first message (`set_objective`). |
| Status summary | Rewritten by the agent as work moves (`set_status`). Becomes the outcome when done. |
| Chat log | Append-only. Your messages and the agent's **final reply per turn** only. The system prompt tells the agent so: its final reply must answer you on its own, findings and all, after any follow-up work. |
| Tool log | Append-only. Every tool call, plus the agent's working notes ("preamble") between them. |

## The window

- **Left sidebar** — workspace switcher, search, New task (+), filter chips (All · Needs you · Unread), and the task
  list in three collapsible sections: Pinned, Active, Done. Each row shows a state dot, title and relative time, then
  a one-line status. Under them, only while there's something to show, a compact third line of what's going on in the
  task, in this order: its todo progress (a ring and `3/7`, a check once all are done, the item in progress as its
  tooltip), its running subagents and its live watchers, each an icon and a count with a tooltip. Unread rows are bold
  with a blue dot. At its foot, under a divider, the **usage meter** (see Usage). Resizable, collapsible.
- **Task card** (centre) — a header card (state dot, title, age, pin toggle, Mark done, goal and status) floating over
  the top of the chat, and the input bar floating over its bottom. The chat, a little narrower than both, scrolls under
  them and is cut off halfway under each, so it never shows past their outer edges. The input bar has model, effort
  and permissions pickers and a context
  meter at the right. Each task keeps its unsent draft, text and pasted images, while you're on another task and
  across a relaunch or a crash, until it's sent.
  A message's pasted images show as thumbnails above its text in the chat, and small in its row while it's queued.
  Clicking one (or ↵ or Space on it) opens the **image viewer** over the window: the image as large as fits, never
  scaled past its own size, on a dimmed backdrop. With several, ← and → step through the message's images, round from
  the last to the first, under a "2 of 3"; Esc, a click on the backdrop or × closes it, and the focus goes back to the
  thumbnail of the image it showed. ![Image viewer](design/screens/30-image-viewer.png)
- **Links** — a link in what the agent or you wrote opens in your browser (a `mailto:` link in your mail app), never in
  Glade: in replies and your messages, the question and permission cards, the tool log's notes and output, the goal
  and status, todos, watchers and queued messages. Markdown links and bare URLs and email addresses are links; URLs in
  code aren't. A link underlines on hover, shows its address as a tooltip when its text says something else, takes the
  focus with Tab and opens with ↵; ⌘-click opens it too. Right-click it for Open link and Copy link. Only web and mail
  links open: any other kind shows as its text.
- **Right panel** (inside the task card) — tabs: Tool calls, Files, Todos, Artifacts, Subagents, Watchers, Changes (the
  commits the task made; Glade watches git and never drives it). Resizable, collapsible. Files is a plain-text editor:
  a workspace file edits in place and saves with ⌘S, its tab showing a dot while it has unsaved edits, and closing it,
  switching task or quitting asks to Save, Discard or Cancel. When the agent changes a file you're editing, it reloads
  quietly, or, with unsaved edits, a bar offers Reload or Keep mine. Files from a commit, binary files and files too
  large to show whole are read-only. Too narrow for its tabs, the
  tab row scrolls sideways, with chevrons at the ends that have more tabs past them.
- **Bottom bar** (full width) — the workspace's terminal, with tabs, and a plugin panel (Nekomata). Resizable,
  collapsible. Each workspace has its own terminal tabs; switching workspace switches them, and the other
  workspaces' shells keep running. Removing a workspace ends its shells.

Each resizable panel has a drag handle in the gap on its inner edge. Dragging it takes room from the chat or gives it
back, within limits (the chat keeps its minimum width and height); collapsing a panel and showing it again brings it
back at the size you left it, and a relaunch keeps every size. The plugin panel beside the terminal has one too, in
the gap between them: it takes room from the terminal, which keeps its minimum width.

State dot colours: blue = working, purple = waiting on you, slate = done, pink = error.

### Usage

The usage meter at the foot of the sidebar (`design/screens/32-usage-meter.png`) is one row: a small ring in the
context meter's colours, the usage limit closest to running out with how much of it is used ("Session 38%"), and when
it resets. Nothing read yet, or nothing said of how much is used, it's an empty ring and "Usage · within limits"; from
70% of a limit the ring and percentage turn purple, as Claude Code's own warning starts there; at a limit the row
takes the question card's highlight ("Session limit · Resets at 15:40"), while the paused tasks' banner shows across
the top as before. Clicking the row opens a popover over it that lists every limit Claude Code has told of (Session,
This week, each model's week, extra usage while it's on), each with a bar, how much is used and when it resets, under
the plan's name and above how long ago it was read ("From Claude Code · updated 2 min ago").

Glade asks Claude Code as each task's session starts and after each turn (its experimental usage call), and also reads
the rate limit events that come as each turn starts; when the call fails, the events alone keep the meter going. It
keeps the latest reading of each limit, so a relaunch shows them again, and drops each when its window resets. An API
key or a cloud provider has no plan limits, so the meter is hidden for them.

## Attention

A task you aren't looking at can still need you. When its agent sends a **final reply**, **asks a question** (`ask`)
or waits on a **permission card**, in a task you're not viewing, Glade marks the task unread, counts it under "Needs
you" while it waits on you, and sends a **native macOS notification** — even while Glade is focused. Working notes and
tool calls never notify. The notification shows the task name and the start of the reply (the first question, or the
tool and what it acts on), with **Open task** and an inline **Reply** that sends your answer to the task without
opening Glade. Settings › Notifications turns them off, or their sound on (off by default); Focus and Do Not Disturb
are left to the OS.

**The menu bar.** Glade's icon in the macOS menu bar shows what's waiting on you in every workspace: a monochrome glyph
that follows light and dark menu bars and never moves, with the count of tasks that need you beside it (blank when none
do). Clicking it drops a popover under it: **Needs you** (the task, its workspace and why: asking, permission, error or
a reply waiting), **Working** (its status line, todo progress with a thin bar, and how long its turn has run) and
**Recent** (the last notifications Glade sent, with their age; kept in the database, so they survive a relaunch), each
hidden while empty, or "Nothing in flight". It updates live while open; a row opens Glade on its task, switching
workspace if needed, and its footer has **Open Glade** and **Quit**. It hides on Esc or when it loses focus
(`design/html/29-menu-bar.html`).

## Settings

Settings (⌘,) opens on Agent. Changes save as you make them.

- **General:** **Show Glade in the menu bar** (on by default): its icon, and the list under it (see Attention). Then
  the account the tasks run on and bill to, as Claude Code reports it when a task starts: the email (or "API key", a
  cloud provider, or "Not signed in"), organization, plan, and what it's signed in with. Nothing to change: Claude Code
  owns the login. How much of its usage limits is used shows in the usage meter at the foot of the sidebar (see
  Usage).
- **Agent:** the defaults for new tasks (model, effort and permissions: Ask first or Allow all; **Allow edits** is shown
  but disabled, as it isn't a mode yet), and two switches for what the agent keeps current: **Status summary**
  (`set_status` every turn) and **Task titles** (`set_title` from your first message). A session started with one off
  gets neither the tool nor the system prompt's ask for it.
- **Notifications:** notifications on or off, and their sound.
- **Appearance:** nothing to set yet; Glade has one theme, dark.
- **Keyboard:** every shortcut, rebindable (`keymap.md`).
- **Plugins:** the plugins installed, each turned on or off, and their folder (`plugin-api.md`).
- **Control:** whether other agents and scripts may drive Glade, and how to connect them (`control-api.md`).
- **Workspace** (under its own heading, by the workspace's name): its name and root folder.

## Everything else

Every interaction is on the interaction map:

![Interaction map](design/screens/interaction-map.png)

Screens for each workflow are indexed in `design/README.md`.
