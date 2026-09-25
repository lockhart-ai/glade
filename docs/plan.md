# Plan

Get the core loop working first, then one phase per major feature. Each phase is a GitHub milestone with a meta issue
that holds its "done when" criteria and its child issues.

## P0 · Foundations

The empty app: tooling, database, bridge, design system, window layout.
[Meta issue #1](https://github.com/lockhart-ai/glade/issues/1)

## P1 · Core loop

One workspace, one task at a time, end to end: create, chat, tool log, done, reopen, resume.
[Meta issue #15](https://github.com/lockhart-ai/glade/issues/15)

## P2 · Parallel tasks and attention

Many tasks at once, the message queue, and knowing which task needs you.
[Meta issue #33](https://github.com/lockhart-ai/glade/issues/33)

## P3 · Context and resilience

Compaction, errors, usage limits, crash recovery.
[Meta issue #39](https://github.com/lockhart-ai/glade/issues/39)

## P4 · Rich questions

The `ask` tool and the question card.
[Meta issue #45](https://github.com/lockhart-ai/glade/issues/45)

## P5 · Right panel tabs

Files, Todos, Artifacts and Subagents.
[Meta issue #48](https://github.com/lockhart-ai/glade/issues/48)

## P6 · Finding and organising

Search, task actions and context menus.
[Meta issue #54](https://github.com/lockhart-ai/glade/issues/54)

## P7 · Workspaces and app shell

Multiple workspaces, menu bar, settings, keymap, collapsible panels.
[Meta issue #58](https://github.com/lockhart-ai/glade/issues/58)

## P8 · Terminal

The global bottom bar with terminal tabs.
[Meta issue #64](https://github.com/lockhart-ai/glade/issues/64)

## P10 · Scaling the Done list

Keep the Done list fast and tidy as it grows to hundreds of tasks.
[Issue #67](https://github.com/lockhart-ai/glade/issues/67)

## P11 · Permission review

An "Ask before edits and commands" mode: edits and commands wait on a permission card in the chat.
[Meta issue #68](https://github.com/lockhart-ai/glade/issues/68)

## P12 · Plugins

Sandboxed plugins beside the terminal, fed task and agent events (`plugin-api.md`), and Nekomata as the first one.
[Meta issue #66](https://github.com/lockhart-ai/glade/issues/66)

## Later

Signing, notarisation and auto-update (L-04, #69).
[Milestone](https://github.com/lockhart-ai/glade/milestone/10)
