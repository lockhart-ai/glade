---
id: P0-05
title: "P0-05: Renderer state store"
milestone: "P0 · Foundations"
labels: [phase-0, ui, infra]
depends_on: [P0-04]
---

# P0-05: Renderer state store

A single store in the renderer that mirrors the DB via bridge events.

## Scope

- Holds workspaces, tasks, the selected task, per-task chat/log, and UI state.
- Hydrates on launch from main; applies events incrementally.
- Selection and UI state are written back so they survive restarts.

## Acceptance criteria

- [ ] Restarting the app restores the selected workspace and task.
- [ ] Store logic is unit-tested.

## Depends on

P0-04
