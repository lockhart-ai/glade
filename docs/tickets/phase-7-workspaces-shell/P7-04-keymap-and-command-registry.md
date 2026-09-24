---
id: P7-04
title: "P7-04: Keymap and command registry"
milestone: "P7 · Workspaces and app shell"
labels: [phase-7, infra, feature]
depends_on: [P7-03]
---

# P7-04: Keymap and command registry

Every action has one command, one binding, and shows it everywhere.

## Scope

- Central command registry; default bindings from `docs/keymap.md`.
- Rebinding in Settings › Keyboard; menus and context menus show current bindings.

## Acceptance criteria

- [ ] Every shortcut in the keymap works.
- [ ] Conflicting bindings are reported.

## Design

![22-keymap](../../design/screens/22-keymap.png)

## Depends on

P7-03
