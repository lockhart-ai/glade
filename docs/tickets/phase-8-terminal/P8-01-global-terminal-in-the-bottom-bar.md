---
id: P8-01
title: "P8-01: Global terminal in the bottom bar"
milestone: "P8 · Terminal"
labels: [phase-8, feature]
depends_on: [P0-07]
---

# P8-01: Global terminal in the bottom bar

A real terminal, always at hand.

## Scope

- Proposed: xterm.js + node-pty. Shells start in the current workspace root.
- Tabs with close buttons, + new tab (⌘T), running-process dot, rename, clear (⌘K), kill (⌃C).
- Scrollback and tabs persist across restarts.
- Tool log "Run again in terminal" sends the command to a terminal tab.

## Acceptance criteria

- [ ] Matches the bottom bar in `task-workspace.png`.

## Design

![task-workspace](../../design/screens/task-workspace.png)

## Depends on

P0-07
