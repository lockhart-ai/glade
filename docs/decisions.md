# Decisions

![Decisions board](design/screens/decisions.png)

## Decided

- **Desktop shell:** Electron. macOS first.
- **Agent runtime:** Claude Agent SDK (TypeScript), running in Electron's main process. It streams typed events, takes
  custom tools in-process, resumes sessions and reads CLAUDE.md files. (Recommended over driving the Claude Code CLI.)
- **Auth:** use the user's Claude subscription (their Claude Code login) if the Agent SDK allows it; API key as the
  fallback. Confirm in P1-05.
- **State:** everything in SQLite — workspaces, tasks, chat, tool log, todos, artifacts, queue, UI state. Reopening
  after a crash resumes from the database.
- **Task folders:** `.glade/tasks/<task>/` inside the workspace root. The folder is the task's working directory (the
  SDK session's `cwd`); the task's files live there, and any git worktree it needs goes there too.
- **Task CLAUDE.md:** the agent's running notes. It updates the file as it works, saves notes there before
  compaction, and context resumes from it.
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

- **Stack:** well-established, widely adopted tools only. electron-vite (build/dev), React + TypeScript (strict),
  CSS Modules with the design tokens as CSS variables, Zustand (renderer store), better-sqlite3 (main process),
  Vitest (unit/integration), ESLint (typescript-eslint) + Prettier, electron-builder (packaging), xterm.js + node-pty
  (terminal).

## Open

- Exact names and schemas for the model surface tools (a draft is in `model-surface.md`).

## Later

- Plugin API (Nekomata and others).
- Handling hundreds of done tasks (pagination, archiving).
- Per-call permission review.
