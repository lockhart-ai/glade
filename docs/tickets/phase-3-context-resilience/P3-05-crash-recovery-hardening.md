---
id: P3-05
title: "P3-05: Crash recovery hardening"
milestone: "P3 · Context and resilience"
labels: [phase-3, agent, data]
depends_on: [P1-12, P2-01]
---

# P3-05: Crash recovery hardening

Relaunch after a crash and carry on.

## Scope

- On launch, find tasks that were mid-turn; resume them from the DB and CLAUDE.md.
- Notice: "Glade quit unexpectedly … 2 tasks … picked up where they left off" with Show them / Dismiss.
- Dividers "Glade restarted · resuming" in chat and "resumed after restart" in the log.

## Acceptance criteria

- [ ] Kill -9 during several running tasks; relaunch resumes all of them.
- [ ] Matches `18-relaunch.png`.

## Design

![18-relaunch](../../design/screens/18-relaunch.png)

## Depends on

P1-12, P2-01
