---
id: P1-08
title: "P1-08: Tool log (right panel, Tool calls tab)"
milestone: "P1 · Core loop"
labels: [phase-1, ui, feature]
depends_on: [P1-05]
---

# P1-08: Tool log (right panel, Tool calls tab)

Every tool call plus the agent's working notes, in order.

## Scope

- Right panel card with the tab bar; only Tool calls is live in this phase (others show empty states).
- Rows: tool name, argument, time, short result; running = blue, done = slate, error = pink; click to expand output.
- Preamble notes between rows with a thin left rule; dividers between turns ("turn 2 · 11:20").
- Collapse button on the panel (full collapse behaviour in P7-05).

## Acceptance criteria

- [ ] Log streams live and survives restart.
- [ ] Matches the right panel in `task-workspace.png`.

## Design

![task-workspace](../../design/screens/task-workspace.png)

## Depends on

P1-05
