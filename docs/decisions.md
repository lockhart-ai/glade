# Decisions

![Decisions board](design/screens/decisions.png)

## Decided

- **Desktop shell:** Electron. macOS first.
- **Agent runtime:** Claude Agent SDK (TypeScript), running in Electron's main process. It streams typed events, takes
  custom tools in-process, resumes sessions and reads CLAUDE.md files. (Recommended over driving the Claude Code CLI.)
- **Auth:** Glade never handles credentials itself: no claude.ai login screen, no reading or storing OAuth tokens. It
  runs the SDK's unmodified bundled Claude Code binary, which picks the credential by its usual precedence. That means
  `ANTHROPIC_API_KEY` if set, otherwise the user's own `claude` login. Reason: Anthropic forbids third-party apps
  from offering claude.ai login or intermediating tokens (see `sdk-notes.md` §1). Whether Glade may run on a
  subscription login at all is still open (below).
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
- **Compaction:** automatic at 99% (configurable), manual from the context meter or ⌘⇧K.
- **Permissions:** default Allow all. No per-call review for now.
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

## Open

- Exact names and schemas for the model surface tools (a draft is in `model-surface.md`).
- **Subscription auth. Needs Jared.** The P1-01 spike confirmed it works technically: the SDK ran on the existing
  Claude Code login with no API key. But Anthropic's docs say developers building on the Agent SDK "should use API key
  authentication". They do not clearly cover one person running an open-source tool on their own login (quotes in
  `sdk-notes.md` §1). So the choice is between API-key-only, or also allowing the user's own login.
- **Auto-compaction at 99%. Needs Jared.** The SDK's auto-compact threshold can only be lowered, not raised. It is
  capped at about the window minus 13k tokens, and defaults to about 83% on a 200k window. See `sdk-notes.md` §5.

## Later

- Plugin API (Nekomata and others).
- Handling hundreds of done tasks (pagination, archiving).
- Per-call permission review.
