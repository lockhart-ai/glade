# Tickets

One file per ticket. Front matter has the id, title, milestone, labels and dependencies.

## P0 · Foundations

The empty app: tooling, database, bridge, design system, window layout.

- [P0-01: Scaffold the Electron + TypeScript + React app](phase-0-foundations/P0-01-scaffold-the-electron-typescript-react-app.md)
- [P0-02: Lint, format, tests and CI](phase-0-foundations/P0-02-lint-format-tests-and-ci.md)
- [P0-03: SQLite database, migrations and first schema](phase-0-foundations/P0-03-sqlite-database-migrations-and-first-schema.md)
- [P0-04: Typed bridge between main and renderer](phase-0-foundations/P0-04-typed-bridge-between-main-and-renderer.md)
- [P0-05: Renderer state store](phase-0-foundations/P0-05-renderer-state-store.md)
- [P0-06: Design tokens and base components](phase-0-foundations/P0-06-design-tokens-and-base-components.md)
- [P0-07: Window layout: floating cards and panels](phase-0-foundations/P0-07-window-layout-floating-cards-and-panels.md)
- [P0-08: App icon](phase-0-foundations/P0-08-app-icon.md)

## P1 · Core loop

One workspace, one task at a time, end to end: create, chat, tool log, done, reopen, resume.

- [P1-01: Workspaces and first run](phase-1-core-loop/P1-01-workspaces-and-first-run.md)
- [P1-02: Task model and task folders](phase-1-core-loop/P1-02-task-model-and-task-folders.md)
- [P1-03: Task list sidebar](phase-1-core-loop/P1-03-task-list-sidebar.md)
- [P1-04: New task](phase-1-core-loop/P1-04-new-task.md)
- [P1-05: Agent runtime with the Claude Agent SDK](phase-1-core-loop/P1-05-agent-runtime-with-the-claude-agent-sdk.md)
- [P1-06: Model surface: set_title, set_objective, set_status](phase-1-core-loop/P1-06-model-surface-set-title-set-objective-set-status.md)
- [P1-07: Chat view](phase-1-core-loop/P1-07-chat-view.md)
- [P1-08: Tool log (right panel, Tool calls tab)](phase-1-core-loop/P1-08-tool-log-right-panel-tool-calls-tab.md)
- [P1-09: Task header](phase-1-core-loop/P1-09-task-header.md)
- [P1-10: Input bar](phase-1-core-loop/P1-10-input-bar.md)
- [P1-11: Mark done, Undo, and reopen by chatting](phase-1-core-loop/P1-11-mark-done-undo-and-reopen-by-chatting.md)
- [P1-12: Persistence and resume](phase-1-core-loop/P1-12-persistence-and-resume.md)

## P2 · Parallel tasks and attention

Many tasks at once, the message queue, and knowing which task needs you.

- [P2-01: Run several tasks at once](phase-2-parallel-attention/P2-01-run-several-tasks-at-once.md)
- [P2-02: Message queue](phase-2-parallel-attention/P2-02-message-queue.md)
- [P2-03: Turn summary line](phase-2-parallel-attention/P2-03-turn-summary-line.md)
- [P2-04: Unread and Needs you](phase-2-parallel-attention/P2-04-unread-and-needs-you.md)
- [P2-05: Native notifications](phase-2-parallel-attention/P2-05-native-notifications.md)

## P3 · Context and resilience

Compaction, errors, usage limits, crash recovery.

- [P3-01: Context meter popover and manual compaction](phase-3-context-resilience/P3-01-context-meter-popover-and-manual-compaction.md)
- [P3-02: Automatic compaction with CLAUDE.md notes](phase-3-context-resilience/P3-02-automatic-compaction-with-claude-md-notes.md)
- [P3-03: Errors inside a task](phase-3-context-resilience/P3-03-errors-inside-a-task.md)
- [P3-04: Usage limit and offline banner](phase-3-context-resilience/P3-04-usage-limit-and-offline-banner.md)
- [P3-05: Crash recovery hardening](phase-3-context-resilience/P3-05-crash-recovery-hardening.md)

## P4 · Rich questions

The `ask` tool and the question card.

- [P4-01: `ask` tool](phase-4-rich-questions/P4-01-ask-tool.md)
- [P4-02: Question card](phase-4-rich-questions/P4-02-question-card.md)

## P5 · Right panel tabs

Files, Todos, Artifacts and Subagents.

- [P5-01: Right panel tabs, resizing and collapse](phase-5-right-panel/P5-01-right-panel-tabs-resizing-and-collapse.md)
- [P5-02: Files tab and file viewer](phase-5-right-panel/P5-02-files-tab-and-file-viewer.md)
- [P5-03: Todos tab](phase-5-right-panel/P5-03-todos-tab.md)
- [P5-04: Artifacts tab and `add_artifact`](phase-5-right-panel/P5-04-artifacts-tab-and-add-artifact.md)
- [P5-05: Subagents tab](phase-5-right-panel/P5-05-subagents-tab.md)

## P6 · Finding and organising

Search, task actions and context menus.

- [P6-01: Search](phase-6-finding-organising/P6-01-search.md)
- [P6-02: Task actions: pin, rename, mark unread, delete](phase-6-finding-organising/P6-02-task-actions-pin-rename-mark-unread-delete.md)
- [P6-03: Context menus](phase-6-finding-organising/P6-03-context-menus.md)

## P7 · Workspaces and app shell

Multiple workspaces, menu bar, settings, keymap, collapsible panels.

- [P7-01: Multiple workspaces and the switcher](phase-7-workspaces-shell/P7-01-multiple-workspaces-and-the-switcher.md)
- [P7-02: macOS menu bar](phase-7-workspaces-shell/P7-02-macos-menu-bar.md)
- [P7-03: Settings modal](phase-7-workspaces-shell/P7-03-settings-modal.md)
- [P7-04: Keymap and command registry](phase-7-workspaces-shell/P7-04-keymap-and-command-registry.md)
- [P7-05: Collapsible panels](phase-7-workspaces-shell/P7-05-collapsible-panels.md)

## P8 · Terminal

The global bottom bar with terminal tabs.

- [P8-01: Global terminal in the bottom bar](phase-8-terminal/P8-01-global-terminal-in-the-bottom-bar.md)

## Later

Plugins, scale, permissions review, packaging.

- [L-01: Plugin API and the Nekomata panel](later/L-01-plugin-api-and-the-nekomata-panel.md)
- [L-02: Scaling to hundreds of done tasks](later/L-02-scaling-to-hundreds-of-done-tasks.md)
- [L-03: Per-call permission review](later/L-03-per-call-permission-review.md)
- [L-04: Signing, notarisation and auto-update](later/L-04-signing-notarisation-and-auto-update.md)
