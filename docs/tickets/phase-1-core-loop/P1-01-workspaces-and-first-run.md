---
id: P1-01
title: "P1-01: Workspaces and first run"
milestone: "P1 · Core loop"
labels: [phase-1, feature]
depends_on: [P0-05, P0-07]
---

# P1-01: Workspaces and first run

A workspace is a name and a root folder. First launch asks for one.

## Scope

- First run screen when no workspace exists: Open folder… / Create a new folder….
- Creating a workspace stores it in the DB (name defaults to the folder name) and creates `.glade/tasks/` in the root.
- Reopen the last workspace on launch.
- Sidebar header shows the current workspace (badge, name, root). The switcher dropdown itself is P7-01.

## Acceptance criteria

- [ ] Fresh install shows the first-run screen; choosing a folder lands in an empty workspace.
- [ ] Relaunch opens the last workspace.

## Design

![20-first-run](../../design/screens/20-first-run.png)

## Depends on

P0-05, P0-07
