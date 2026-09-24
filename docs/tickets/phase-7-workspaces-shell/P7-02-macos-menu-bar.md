---
id: P7-02
title: "P7-02: macOS menu bar"
milestone: "P7 · Workspaces and app shell"
labels: [phase-7, feature]
depends_on: [P7-01]
---

# P7-02: macOS menu bar

A proper native menu bar.

## Scope

- Menus: Glade, File, Edit, View, Workspace, Task, Window, Help.
- Workspace menu: Switch workspace ▸ (⌘1–9), New…, Open folder…, Rename…, Change root folder…, Settings…, Reveal root, Close workspace, Remove from list….
- Task menu mirrors task actions. Shortcuts from the keymap registry.

## Acceptance criteria

- [ ] Matches `15-workspace-menu.png`.

## Design

![15-workspace-menu](../../design/screens/15-workspace-menu.png)

## Depends on

P7-01
