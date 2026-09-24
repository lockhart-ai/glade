---
id: P1-12
title: "P1-12: Persistence and resume"
milestone: "P1 · Core loop"
labels: [phase-1, data, agent]
depends_on: [P1-05, P0-05]
---

# P1-12: Persistence and resume

Quit or crash at any moment and pick up where you left off.

## Scope

- All state from the DB on launch: workspace, selected task, scroll positions, panel state.
- Tasks that were mid-turn resume their SDK session on launch (basic version; hardening in P3-05).

## Acceptance criteria

- [ ] Force-quit during a turn, relaunch: the task continues and nothing is lost.

## Design

![18-relaunch](../../design/screens/18-relaunch.png)

## Depends on

P1-05, P0-05
