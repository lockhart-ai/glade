---
id: P7-01
title: "P7-01: Multiple workspaces and the switcher"
milestone: "P7 · Workspaces and app shell"
labels: [phase-7, feature]
depends_on: [P1-01, P2-01]
---

# P7-01: Multiple workspaces and the switcher

Several workspaces, one click apart.

## Scope

- Workspace switcher dropdown from the sidebar header: each workspace with badge, name, root and a status ("3 active", "1 needs you", idle); New workspace…, Open folder as workspace…, Workspace settings…, Reveal root.
- Background tasks keep running in other workspaces and still notify.

## Acceptance criteria

- [ ] Switching is instant and restores each workspace's selection.
- [ ] Matches `14-workspace-switcher.png`.

## Design

![14-workspace-switcher](../../design/screens/14-workspace-switcher.png)

## Depends on

P1-01, P2-01
