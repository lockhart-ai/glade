---
id: P6-02
title: "P6-02: Task actions: pin, rename, mark unread, delete"
milestone: "P6 · Finding and organising"
labels: [phase-6, feature]
depends_on: [P1-03]
---

# P6-02: Task actions: pin, rename, mark unread, delete

Organise the task list.

## Scope

- Pin / unpin (header toggle and menu, ⌘⇧P); Rename (F2, inline); Mark as unread (⌘⇧U).
- Delete task… with confirmation; removes the DB rows and the task folder.

## Acceptance criteria

- [ ] Actions persist and update the list live.
- [ ] Delete cannot happen without confirming.

## Design

![12-right-click-task](../../design/screens/12-right-click-task.png)

## Depends on

P1-03
