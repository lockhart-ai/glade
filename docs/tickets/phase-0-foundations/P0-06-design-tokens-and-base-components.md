---
id: P0-06
title: "P0-06: Design tokens and base components"
milestone: "P0 · Foundations"
labels: [phase-0, ui, design]
depends_on: [P0-01]
---

# P0-06: Design tokens and base components

The palette, type and components every screen is built from.

## Scope

- Tokens from `docs/design/tokens.md` as CSS variables.
- Bundle Geist and Geist Mono locally (no network fonts).
- Components: Card (top-level and nested), Button (primary, dark, ghost, icon), Pill, Dot, Tabs, Menu, Popover, Toast, Input, Textarea, Kbd, Divider, Toggle, Segmented control.
- Icons: simple inline stroke SVGs; no emoji.

## Acceptance criteria

- [ ] A dev-only component gallery page shows every component in its states.
- [ ] Text meets 4.5:1 contrast against its background.

## Design

![task-workspace](../../design/screens/task-workspace.png)
![22-keymap](../../design/screens/22-keymap.png)

## Depends on

P0-01
