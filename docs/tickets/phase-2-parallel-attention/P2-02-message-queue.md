---
id: P2-02
title: "P2-02: Message queue"
milestone: "P2 · Parallel tasks and attention"
labels: [phase-2, feature]
depends_on: [P2-01]
---

# P2-02: Message queue

Messages sent while the agent works wait until its current step finishes.

## Scope

- While working, send queues the message; queued messages show above the input (numbered).
- Each can be edited or removed. No reordering, no send-now.
- Queue is delivered in order after the current step; it persists in the DB.

## Acceptance criteria

- [ ] Queue survives restart.
- [ ] Matches `02-agent-working.png`.

## Design

![02-agent-working](../../design/screens/02-agent-working.png)

## Depends on

P2-01
