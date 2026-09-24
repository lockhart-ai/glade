---
id: P1-03
title: "P1-03: Task list sidebar"
milestone: "P1 · Core loop"
labels: [phase-1, ui, feature]
depends_on: [P1-02]
---

# P1-03: Task list sidebar

The list of tasks in the current workspace.

## Scope

- Sections: Pinned, Active, Done — each collapsible, with counts; collapse state persists.
- Row: state dot (blue working, purple waiting, slate done, pink error), title, one-line status, relative time (now, 4m, 2h, 3d, 1w).
- Selecting a row opens the task. Keyboard: ⌥↑/⌥↓.
- Search box and filter chips render but are wired up in P2-04 and P6-01.

## Acceptance criteria

- [ ] List updates live as tasks change.
- [ ] Matches the sidebar in `task-workspace.png`.

## Design

![task-workspace](../../design/screens/task-workspace.png)

## Depends on

P1-02
