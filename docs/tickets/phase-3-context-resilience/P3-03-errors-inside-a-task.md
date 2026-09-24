---
id: P3-03
title: "P3-03: Errors inside a task"
milestone: "P3 · Context and resilience"
labels: [phase-3, feature]
depends_on: [P2-01]
---

# P3-03: Errors inside a task

When the agent can't continue, say so plainly and offer a way on.

## Scope

- Automatic retries with backoff for transient API errors (e.g. 3 over ~2 minutes).
- Then: pink error card in chat ("The agent stopped", what happened, nothing is lost) with Retry, Retry with another model, Show details.
- Header pill "Active · stopped by an error"; pink dot and "Error: …" line in the sidebar; failed row in the log.

## Acceptance criteria

- [ ] Retry resumes the same turn.
- [ ] Matches `16-error.png`.

## Design

![16-error](../../design/screens/16-error.png)

## Depends on

P2-01
