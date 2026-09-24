---
id: P2-04
title: "P2-04: Unread and Needs you"
milestone: "P2 · Parallel tasks and attention"
labels: [phase-2, feature]
depends_on: [P2-01]
---

# P2-04: Unread and Needs you

Know which tasks need you without opening them.

## Scope

- A task becomes unread when the agent posts a message while you're not viewing it; opening it clears unread.
- "Needs you" = active tasks whose turn has ended (waiting on you, question, or error).
- Sidebar: unread rows bold with a blue dot; filter chips All / Needs you / Unread with counts.
- Mark as unread action (also in the context menu, P6-03).

## Acceptance criteria

- [ ] Counts and filters are correct across restarts.
- [ ] Matches `04-needs-you.png`.

## Design

![04-needs-you](../../design/screens/04-needs-you.png)

## Depends on

P2-01
