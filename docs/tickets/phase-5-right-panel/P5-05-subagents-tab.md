---
id: P5-05
title: "P5-05: Subagents tab"
milestone: "P5 · Right panel tabs"
labels: [phase-5, feature]
depends_on: [P5-01]
---

# P5-05: Subagents tab

See the agent's helpers at a glance.

## Scope

- From SDK subagent events: name, status (running / done / queued), elapsed, tool-call count, latest line (last tool call or last thing it said).
- Tally at the top (3 running · 1 done · 1 queued).
- Click a row to expand its log inline (same style as the tool log); click again to collapse.

## Acceptance criteria

- [ ] Matches `11-subagents.png`.

## Design

![11-subagents](../../design/screens/11-subagents.png)

## Depends on

P5-01
