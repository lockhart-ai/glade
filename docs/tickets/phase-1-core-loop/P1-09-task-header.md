---
id: P1-09
title: "P1-09: Task header"
milestone: "P1 · Core loop"
labels: [phase-1, ui, feature]
depends_on: [P1-06]
---

# P1-09: Task header

Title, status and the main task actions.

## Scope

- Title with pin toggle; status pill (Active · working / waiting on you / error, Done · date); started time.
- Rows: Objective, Status (with "updated 4m ago"); for done tasks Status becomes Outcome.
- Mark done button (active tasks only).

## Acceptance criteria

- [ ] Header reflects state changes live.
- [ ] Pin toggle moves the task into Pinned.

## Design

![task-workspace](../../design/screens/task-workspace.png)
![05-mark-done](../../design/screens/05-mark-done.png)

## Depends on

P1-06
