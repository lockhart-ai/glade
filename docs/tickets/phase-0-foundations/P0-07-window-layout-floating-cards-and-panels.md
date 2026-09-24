---
id: P0-07
title: "P0-07: Window layout: floating cards and panels"
milestone: "P0 · Foundations"
labels: [phase-0, ui]
depends_on: [P0-06]
---

# P0-07: Window layout: floating cards and panels

The empty frame of the app, matching the task workspace screen.

## Scope

- Flat `bg` window with 12px padding; sidebar card (300px), task card, and full-width bottom bar card(s).
- Inside the task card: header card and right panel card floating above the chat area.
- Placeholders for content; real content comes in later tickets.

## Acceptance criteria

- [ ] Layout matches `task-workspace.png` at 1920×1200 and stays usable at 1100×700.

## Design

![task-workspace](../../design/screens/task-workspace.png)

## Depends on

P0-06
