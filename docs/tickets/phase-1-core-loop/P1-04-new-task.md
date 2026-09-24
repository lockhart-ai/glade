---
id: P1-04
title: "P1-04: New task"
milestone: "P1 · Core loop"
labels: [phase-1, feature]
depends_on: [P1-03]
---

# P1-04: New task

The + button (⌘N) opens an empty task; the first message starts it.

## Scope

- Empty task view: header shows "New task", objective and status placeholders, prompt in the chat area.
- The task row appears in Active as "New task · Waiting for instructions".
- Sending the first message starts the agent (P1-05).

## Acceptance criteria

- [ ] ⌘N and the + button both create and focus a new task.
- [ ] Matches `01-new-task.png`.

## Design

![01-new-task](../../design/screens/01-new-task.png)

## Depends on

P1-03
