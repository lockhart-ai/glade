---
id: P2-01
title: "P2-01: Run several tasks at once"
milestone: "P2 · Parallel tasks and attention"
labels: [phase-2, agent]
depends_on: [P1-12]
---

# P2-01: Run several tasks at once

Multiple active tasks, each with its own running session.

## Scope

- A task runner in main that manages concurrent SDK sessions and routes events by task.
- Switching tasks never interrupts a running one.
- Status dots and sidebar rows update for background tasks.

## Acceptance criteria

- [ ] Three tasks can run simultaneously without cross-talk.
- [ ] Tests cover event routing.

## Design

![02-agent-working](../../design/screens/02-agent-working.png)

## Depends on

P1-12
