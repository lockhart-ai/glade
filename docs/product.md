# Glade — product overview

![Task workspace](design/screens/task-workspace.png)

## Concepts

**Workspace.** The top level: a name and a root folder. Every task's agent runs in the workspace root, so the root's
`CLAUDE.md` (your conventions and personal context) applies to every task. Task records live only in the app's SQLite
database. How tasks organise files on disk (a folder per task, worktrees inside it) is a convention written in that
`CLAUDE.md`, not something Glade enforces; Glade seeds a starter `CLAUDE.md` for a new workspace that has none. You can
have several workspaces and switch between them from the sidebar or the menu bar (⌘1–9). Close workspace (⌘⇧W) shows
the most recently opened other workspace, or the welcome screen when there's none; the workspace stays in the list.
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
| Chat log | Append-only. Your messages and the agent's **final reply per turn** only. |
| Tool log | Append-only. Every tool call, plus the agent's working notes ("preamble") between them. |

## The window

- **Left sidebar** — workspace switcher, search, New task (+), filter chips (All · Needs you · Unread), and the task
  list in three collapsible sections: Pinned, Active, Done. Each row shows a state dot, title, a one-line status and a
  relative time; while the agent keeps a todo list, the status ends with its progress (a ring and `3/7`, a check once
  all are done, the item in progress as its tooltip). Unread rows are bold with a blue dot. Resizable, collapsible.
- **Task card** (centre) — a header card (state dot, title, age, pin toggle, Mark done, goal and status) floating over
  the top of the chat, and the input bar floating over its bottom. The chat, a little narrower than both, scrolls under
  them and is cut off halfway under each, so it never shows past their outer edges. The input bar has model, effort
  and permissions pickers and a context
  meter at the right. Each task keeps its unsent draft, text and pasted images, while you're on another task and
  across a relaunch or a crash, until it's sent.
- **Right panel** (inside the task card) — tabs: Tool calls, Files, Todos, Artifacts, Subagents, Watchers, Changes (the
  commits the task made; Glade watches git and never drives it). Resizable, collapsible. Too narrow for its tabs, the
  tab row scrolls sideways, with chevrons at the ends that have more tabs past them.
- **Bottom bar** (full width) — a global terminal with tabs, and a plugin panel (Nekomata). Resizable, collapsible.

Each resizable panel has a drag handle in the gap on its inner edge. Dragging it takes room from the chat or gives it
back, within limits (the chat keeps its minimum width and height); collapsing a panel and showing it again brings it
back at the size you left it, and a relaunch keeps every size. The plugin panel beside the terminal has one too, in
the gap between them: it takes room from the terminal, which keeps its minimum width.

State dot colours: blue = working, purple = waiting on you, slate = done, pink = error.

## Attention

A task you aren't looking at can still need you. When its agent sends a **final reply**, **asks a question** (`ask`)
or waits on a **permission card**, in a task you're not viewing, Glade marks the task unread, counts it under "Needs
you" while it waits on you, and sends a **native macOS notification** — even while Glade is focused. Working notes and
tool calls never notify. The notification shows the task name and the start of the reply (the first question, or the
tool and what it acts on), with **Open task** and an inline **Reply** that sends your answer to the task without
opening Glade. Settings › Notifications turns them off, or their sound on (off by default); Focus and Do Not Disturb
are left to the OS.

**The menu bar.** Glade's icon in the macOS menu bar shows what's in flight in every workspace: a monochrome glyph
that follows light and dark menu bars, with the count of tasks that need you beside it, pulsing gently while any agent
works (still with Reduce motion). Clicking it drops a popover under it: **Needs you** (the task, its workspace and why:
asking, permission, error or a reply waiting), **Working** (its status line, todo progress with a thin bar, and how
long its turn has run) and **Recent** (the last notifications Glade sent, with their age; kept in the database, so
they survive a relaunch), each hidden while empty, or "Nothing in flight". It updates live while open; a row opens
Glade on its task, switching workspace if needed, and its footer has **Open Glade** and **Quit**. It hides on Esc or
when it loses focus (`design/html/29-menu-bar.html`).

## Settings

Settings (⌘,) opens on Agent. Changes save as you make them.

- **General:** **Show Glade in the menu bar** (on by default): its icon, and the list under it (see Attention). Then
  the account the tasks run on and bill to, as Claude Code reports it when a task starts: the email (or "API key", a
  cloud provider, or "Not signed in"), organization, plan, and what it's signed in with. Nothing to change: Claude Code
  owns the login. While the account is close to a usage limit (70% of a window or more), a quiet note in the app-wide
  banner's spot says how much is used and when it resets; the paused tasks' banner takes its place if the limit runs
  out.
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
