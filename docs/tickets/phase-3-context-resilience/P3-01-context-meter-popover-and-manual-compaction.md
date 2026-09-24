---
id: P3-01
title: "P3-01: Context meter popover and manual compaction"
milestone: "P3 · Context and resilience"
labels: [phase-3, feature]
depends_on: [P1-10]
---

# P3-01: Context meter popover and manual compaction

See how full the context is and compact on demand.

## Scope

- Clicking the meter opens a popover: percentage, used / limit, marker at the auto threshold, Compact now (⌘⇧K).
- Ring turns purple near the threshold.

## Acceptance criteria

- [ ] Compact now runs compaction (P3-02 flow) and the meter drops.

## Design

![19-compaction](../../design/screens/19-compaction.png)

## Depends on

P1-10
