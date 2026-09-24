# Plan

Get the core loop working first, then one phase per major feature. Phases are milestones; tickets are in `tickets/`.

## P0 · Foundations

The empty app: tooling, database, bridge, design system, window layout.

- **P0-01** Scaffold the Electron + TypeScript + React app
- **P0-02** Lint, format, tests and CI
- **P0-03** SQLite database, migrations and first schema
- **P0-04** Typed bridge between main and renderer
- **P0-05** Renderer state store
- **P0-06** Design tokens and base components
- **P0-07** Window layout: floating cards and panels
- **P0-08** App icon

## P1 · Core loop

One workspace, one task at a time, end to end: create, chat, tool log, done, reopen, resume.

- **P1-01** Workspaces and first run
- **P1-02** Task model and task folders
- **P1-03** Task list sidebar
- **P1-04** New task
- **P1-05** Agent runtime with the Claude Agent SDK
- **P1-06** Model surface: set_title, set_objective, set_status
- **P1-07** Chat view
- **P1-08** Tool log (right panel, Tool calls tab)
- **P1-09** Task header
- **P1-10** Input bar
- **P1-11** Mark done, Undo, and reopen by chatting
- **P1-12** Persistence and resume

## P2 · Parallel tasks and attention

Many tasks at once, the message queue, and knowing which task needs you.

- **P2-01** Run several tasks at once
- **P2-02** Message queue
- **P2-03** Turn summary line
- **P2-04** Unread and Needs you
- **P2-05** Native notifications

## P3 · Context and resilience

Compaction, errors, usage limits, crash recovery.

- **P3-01** Context meter popover and manual compaction
- **P3-02** Automatic compaction with CLAUDE.md notes
- **P3-03** Errors inside a task
- **P3-04** Usage limit and offline banner
- **P3-05** Crash recovery hardening

## P4 · Rich questions

The `ask` tool and the question card.

- **P4-01** `ask` tool
- **P4-02** Question card

## P5 · Right panel tabs

Files, Todos, Artifacts and Subagents.

- **P5-01** Right panel tabs, resizing and collapse
- **P5-02** Files tab and file viewer
- **P5-03** Todos tab
- **P5-04** Artifacts tab and `add_artifact`
- **P5-05** Subagents tab

## P6 · Finding and organising

Search, task actions and context menus.

- **P6-01** Search
- **P6-02** Task actions: pin, rename, mark unread, delete
- **P6-03** Context menus

## P7 · Workspaces and app shell

Multiple workspaces, menu bar, settings, keymap, collapsible panels.

- **P7-01** Multiple workspaces and the switcher
- **P7-02** macOS menu bar
- **P7-03** Settings modal
- **P7-04** Keymap and command registry
- **P7-05** Collapsible panels

## P8 · Terminal

The global bottom bar with terminal tabs.

- **P8-01** Global terminal in the bottom bar

## Later

Plugins, scale, permissions review, packaging.

- **L-01** Plugin API and the Nekomata panel
- **L-02** Scaling to hundreds of done tasks
- **L-03** Per-call permission review
- **L-04** Signing, notarisation and auto-update
