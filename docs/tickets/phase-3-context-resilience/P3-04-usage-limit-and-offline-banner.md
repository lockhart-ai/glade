---
id: P3-04
title: "P3-04: Usage limit and offline banner"
milestone: "P3 · Context and resilience"
labels: [phase-3, feature]
depends_on: [P3-03, P2-02]
---

# P3-04: Usage limit and offline banner

App-wide problems get one banner, not a mess of errors.

## Scope

- Detect usage-limit and network loss; pause affected tasks and show one banner across the top of the window ("3 tasks are paused and will resume on their own at 11:42") with Switch model / Details.
- Paused tasks show "Paused…" in the sidebar and a paused line in chat; messages sent meanwhile are queued.
- Resume automatically when the limit resets or the network returns.

## Acceptance criteria

- [ ] Tasks resume without user action.
- [ ] Matches `17-usage-limit.png`.

## Design

![17-usage-limit](../../design/screens/17-usage-limit.png)

## Depends on

P3-03, P2-02
