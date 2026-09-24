---
id: P2-05
title: "P2-05: Native notifications"
milestone: "P2 · Parallel tasks and attention"
labels: [phase-2, feature]
depends_on: [P2-04]
---

# P2-05: Native notifications

OS notifications for messages from tasks you aren't viewing.

## Scope

- Any agent message in a task you're not viewing → native macOS notification, even while Glade is focused.
- Title = task name; body = the start of the message; app icon = Glade.
- Clicking opens Glade on that task. Sound off by default. Focus / DND left to the OS.

## Acceptance criteria

- [ ] No notification for the task you're viewing.
- [ ] Clicking a notification focuses the right task.

## Design

![04-needs-you](../../design/screens/04-needs-you.png)

## Depends on

P2-04
