# Decisions

![Decisions board](design/screens/decisions.png)

## Decided

- **Desktop shell:** Electron. macOS first.
- **Agent runtime:** Claude Agent SDK (TypeScript), running in Electron's main process. It streams typed events, takes
  custom tools in-process, resumes sessions and reads CLAUDE.md files. (Recommended over driving the Claude Code CLI.)
- **Auth:** login-based. Glade runs on the user's own Claude Code login. Glade never handles credentials itself: no
  claude.ai login screen, no reading or storing OAuth tokens. It runs the SDK's unmodified bundled Claude Code binary,
  which still uses `ANTHROPIC_API_KEY` if one happens to be set. Policy risk: Anthropic's docs don't clearly permit
  subscription use by a third-party app (see `sdk-notes.md` §1 and Open risks).
- **State:** everything in SQLite — workspaces, tasks, chat, tool log, todos, artifacts, queue, UI state. Reopening
  after a crash resumes from the database.
- **Agent sessions run in the workspace root** (the SDK session's `cwd`), so the workspace's own `CLAUDE.md` (the
  user's conventions and personal context) loads for every task.
- **Task metadata lives only in SQLite.** Glade keeps nothing of its own on disk in the workspace.
- **On-disk layout is convention, not app logic.** Where a task keeps its files (e.g. a folder per task, worktrees
  inside it) is described in the workspace `CLAUDE.md`. When Glade creates a workspace whose root has no `CLAUDE.md`,
  it writes a starter one describing a task-folder convention; it never modifies an existing one. The system prompt
  gives the agent its task's id and title so conventions can use them.
- **Compaction** relies on the SDK's own summary. Any note-keeping before compaction is up to the workspace
  conventions, not Glade.
- **Deleting a task** removes its database rows only; it never touches files on disk.
- **Model ↔ app surface:** the app exposes tools the model uses to drive the UI (see `model-surface.md`). The agent
  sets the title and objective from your first message and keeps the status current.
- **Two task states:** Active and Done. Done stays chat-able; a message reopens it. No follow-up tasks.
- **Workspace** = name + root folder, top level. Switcher in the sidebar and the macOS menu bar.
- **Chat shows final replies only.** Preamble goes to the tool log.
- **Compaction:** automatic at the SDK's default auto-compact threshold; manual from the context meter or ⌘⇧K. The
  meter shows the threshold the SDK reports (`getContextUsage`), which follows the user's own Claude Code settings
  (#279).
- **Permissions:** default Allow all. Each task can switch to "Ask before edits and commands" instead (P11, see
  below).
- **Message queue:** messages sent while the agent works are queued and delivered after its current step. They can be
  edited or removed. No "send now", no reordering.
- **Notifications:** native OS notifications for any agent message in a task you're not viewing, even while Glade is
  focused. Task name + start of the message. Sound off. Focus/DND handled by the OS.
- **Terminal** is global (not per task). **Settings** are a modal.
- **Name:** Glade. **Icon:** "Stepping up" — three grass blades rising into the wind, the middle one lit
  (`assets/icon/`).

- **Stack:** well-established, widely adopted tools only. electron-vite (build/dev), React + TypeScript (strict), CSS
  Modules with the design tokens as CSS variables, Zustand (renderer store), better-sqlite3 (main process), Vitest +
  React Testing Library (unit/integration, 100% line coverage), ESLint (typescript-eslint) + Prettier, electron-builder
  (packaging), xterm.js + node-pty (terminal).
- **Terminal internals:** main owns the shells, one node-pty pseudo-terminal per tab, each your login shell (`$SHELL
  -l`) started in the root of the workspace you're looking at. The renderer draws them with xterm.js (`@xterm/xterm`
  and its fit addon) and reaches them only through typed, zod-validated bridge commands (attach, type, resize, clear,
  interrupt, close): it can't name a program or a folder to run, only type into a shell you opened. node-pty is a
  Node-API addon with prebuilt macOS binaries, so it loads under Node and Electron alike and needs no rebuild
  (`npmRebuild: false`, as for better-sqlite3); `scripts/fix-node-pty.mjs` makes its prebuilt spawn-helper executable
  after install (1.1.0 ships it without the bit), and electron-builder unpacks it from the asar archive. Unit tests run
  on a fake pseudo-terminal; only the app and the e2e specs start real shells (e2e mode runs a plain bash). Tabs,
  names, folders and each tab's last 100,000 characters of output live in SQLite; a relaunch shows that output above a
  new shell under a dim "restored" divider, since processes don't survive a restart.
- **Icons:** Font Awesome (free regular + solid SVG icons via the official React packages), bundled locally; regular
  style preferred to match the designs' thin strokes.
- **Overlays:** Floating UI (`@floating-ui/react`) positions menus and popovers and handles their focus, dismissal and
  list keyboard navigation; overlays render in a portal.
- **Long lists:** the Done section loads from SQLite a page at a time (keyset pagination on the list's own order, over
  an index), and renders only the rows in view with TanStack Virtual (`@tanstack/react-virtual`); everything outside it
  is loaded whole. No archiving (L-02, #67).
- **Validation:** zod at every boundary (IPC requests, SDK events, tool inputs, JSON from disk); schemas are checked
  against the named interfaces.
- **Releases:** one minor release per phase (P1 is 0.1.0), built and published by `.github/workflows/release.yml` from
  a pushed tag (`releasing.md`). Apple silicon only. Builds are **ad-hoc signed** (no certificate, not notarised) so a
  download opens with right-click → Open instead of being reported as damaged. Developer ID signing and notarisation
  come later (L-04, #69).

- **Per-call permission review (P11, #68).**
  - The input bar's permissions picker has two modes: **Allow all** (the default) and **Ask before edits and
    commands**. The mode is saved per task, like model and effort. Settings › Agent › Permissions sets the default
    for new tasks: its "Ask first" option becomes this mode and "Allow edits" stays disabled.
  - In the ask mode, tools with side effects ask first: `Bash`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`,
    `Monitor` (it runs a shell command), `RemoteTrigger` and `SendMessage` (they reach outside), and any tool Glade
    doesn't know to be read-only, including other MCP servers'
    tools. Reads and searches (`Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, …), Claude Code's todo and subagent
    tools, the agent's follow-up tools that only schedule itself or tell you (`ScheduleWakeup`, `CronCreate`,
    `CronDelete`, `CronList`, `PushNotification`, `ListAgents`), Glade's own MCP tools (`mcp__glade__*`), and the
    reads of Glade's control tools (`glade-control`'s `list_*` and `get_*`, when the SDK says the server is Glade's
    in-process one) never ask. The control tools that change things (`create_task`, `update_task`, `send_message`,
    `stop_task`, `mark_done`, `reopen_task`, `delete_task`) ask, as other MCP servers' tools do: only `glade` is
    pre-approved (`allowedTools`) and trusted wholesale. The user's own settings still apply: their allow
    and deny rules decide without asking, and a user `ask` rule shows the card even for a read.
  - A request shows as a **permission card** in the chat, styled like the `ask` question card: the tool, its input
    (the command, or the file and the change), and, for a subagent's call, which subagent. It offers **Allow once**,
    **Allow for this task** (that tool, or for `Bash` that command prefix) and **Deny**, with an optional note that
    goes back to the agent. When the SDK says a request mustn't be remembered (`suppressAlwaysAllowRule`), Allow for
    this task isn't offered; when it says it mustn't be approved by a stray key (`defaultToNo`), Deny has the focus.
  - While a card waits, the task needs you, exactly as with an open question: purple dot, Needs you, unread and a
    native notification when you aren't viewing it. A message sent meanwhile is queued as usual; Stop withdraws the
    request.
  - The rules granted by Allow for this task are stored per task in SQLite and apply for the rest of the task,
    across relaunches. Pending requests are stored too: after a relaunch the card is still there and the task still
    needs you. The call itself can't survive (its Claude Code process is gone), so answering then resumes the session
    and tells the agent the decision in a message, as a question answered after a restart does. See
    `sdk-notes.md` §9.
- **Plugins (P12, #66).**
  - A plugin is a folder `~/Library/Application Support/glade/plugins/<id>/` (Glade's `userData`) holding a
    `manifest.json`: `id` (the folder's name), `name`, `version`, `entry` (an HTML file in the folder) and an optional
    `icon`. The manifest is validated with zod; a plugin whose manifest is invalid is listed with the reason and
    doesn't load. Installing is copying a folder there; there's no store or installer.
  - A plugin renders in the bottom bar's right side, beside the terminal (the Nekomata card in `task-workspace.png`),
    in a sandboxed view of its own: a separate process (a `WebContentsView` with its own session), no Node, a preload
    that only relays messages, a CSP that blocks all network except localhost, no navigation and no new windows.
  - Glade sends it typed task and agent events with `postMessage`, in a versioned schema (`plugin-api.md`). The plugin
    sends back only `ready` and a short header status. It can't command Glade.
  - Settings › Plugins lists the installed plugins, each with an enable/disable toggle, and has **Open plugins
    folder**. Whether each plugin is enabled lives in SQLite.
  - The bottom bar splits into terminal | plugin with a drag handle; the plugin's width is saved in SQLite. With no
    enabled plugin, the terminal takes the whole bar.
  - Nekomata gets a Glade build that consumes these events instead of reading transcripts (work in the nekomata
    repo, tracked in this one).
  - These parts have no design screens. They're built from the existing tokens and components, and their PRs include
    screenshots for review.

- **Programmatic control (P13, #219).** Details in `control-api.md`.
  - Other agents can drive Glade through one MCP server, `glade-control`: list workspaces; list, read, create, update,
    message, stop, mark done, reopen and delete tasks; list and import Claude Code sessions. Its tools are defined once
    in main, over a **control service** that uses the same code as the window's commands, so the API and the UI
    behave the same and every change reaches open windows.
  - It's served two ways: **in-process** to Glade's own tasks, next to `glade` (behind tool search, not `alwaysLoad`),
    and as a **Streamable HTTP endpoint** (the official `@modelcontextprotocol/sdk`) on `127.0.0.1` only, port 45233 by
    default and configurable, falling back to the next nine when taken, behind a random bearer token kept in SQLite
    that Settings can regenerate. Every request's `Host` and `Origin` are checked against DNS rebinding. The same server
    answers plain JSON at `/v1/tools` for scripts (Jared, for backfills of hundreds of tasks), and Glade's own agents get
    `GLADE_CONTROL_URL` and `GLADE_CONTROL_TOKEN` in their environment while it listens.
  - **Settings › Control** has one switch, **Let agents control Glade**, off by default. When it's on it shows the
    endpoint, a copy-ready `claude mcp add --transport http glade-control …` command with the token, Regenerate token,
    the port, and a note that Glade's own tasks get the tools too.
  - **Importing** a Claude Code transcript (`~/.claude/projects/<slug>/<sessionId>.jsonl`): Glade parses it itself,
    tolerantly, into a task in the workspace whose root is the transcript's folder (failing when there's none, unless
    the caller asks for that folder to be added as a workspace), with its title, chat, tool log and turn dividers at
    their original times, done by default. The task keeps the session id, so a message resumes the Claude Code
    session. Importing a session twice returns the same task.
  - **Backfilling past tasks (P13-04):** `create_task` can make a past task from its notes: a Markdown **handoff
    note** (at most 32 KB) kept with the task in SQLite, files of its workspace as its **artifacts** (the existing
    artifacts store and tab, so only files inside the workspace, by absolute path), a **start date** that dates and
    orders it, **done** at that date, and an **external id** (unique) that makes running the backfill again safe: the
    same id returns the task already made. A backfilled task never starts its agent by itself. The note shows on a
    **Backfilled** card at the top of the chat (collapsible, rendered Markdown, with the date it was added; never
    edited in the window) and goes at the end of the system prompt of a session Glade starts, so compaction can't lose
    it. Claude Code keeps a resumed session's original prompt, so a session that started without the note, or with an
    older one, is sent it once as a `[Glade: handoff for this task] … [end]` block ahead of the next message (the chat
    shows only the message); what each session has been given is kept in SQLite. `update_task` sets or clears the note
    and adds artifacts without moving the task.
  - **Safety:** a task can't stop, delete or message itself through the API; deletes need `confirm: true`; calls are
    rate limited per caller; everything is logged under `control`, never the token. In the ask mode, `glade-control`
    tools that change things ask like other MCP tools; its reads (`list_*`, `get_*`) never ask when the SDK says the
    server is Glade's in-process one.

## Open

- Exact names and schemas for the model surface tools (a draft is in `model-surface.md`).

## Later

- Customising the auto-compact threshold (see `sdk-notes.md` §5 for the SDK's limits).
