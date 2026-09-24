---
id: P4-01
title: "P4-01: `ask` tool"
milestone: "P4 · Rich questions"
labels: [phase-4, agent]
depends_on: [P1-06]
---

# P4-01: `ask` tool

Let the agent ask structured questions and wait for answers.

## Scope

- Schema per `docs/model-surface.md` (choice with optional sketch/detail, pills, text; single or multiple).
- The tool call blocks the turn until answered; answers return as JSON.
- A plain chat reply while a question is open also answers it (returned as free text).

## Acceptance criteria

- [ ] Unit tests for schema validation and answer shaping.

## Design

![03-rich-question](../../design/screens/03-rich-question.png)

## Depends on

P1-06
