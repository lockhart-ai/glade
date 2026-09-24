---
id: P0-04
title: "P0-04: Typed bridge between main and renderer"
milestone: "P0 · Foundations"
labels: [phase-0, infra]
depends_on: [P0-01, P0-03]
---

# P0-04: Typed bridge between main and renderer

One typed API the renderer calls, and one event stream it subscribes to.

## Scope

- Preload exposes a typed `window.glade` API (commands) and an event subscription for state changes.
- Shared TypeScript types for commands and events in a common package/folder.
- No raw `ipcRenderer` in renderer code.

## Acceptance criteria

- [ ] A round-trip test: renderer calls a command, main updates the DB, renderer receives the event.
- [ ] Types are shared, so a mismatch fails the typecheck.

## Depends on

P0-01, P0-03
