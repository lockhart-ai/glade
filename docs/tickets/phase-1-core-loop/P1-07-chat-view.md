---
id: P1-07
title: "P1-07: Chat view"
milestone: "P1 · Core loop"
labels: [phase-1, ui, feature]
depends_on: [P1-05]
---

# P1-07: Chat view

Your messages and the agent's final reply per turn — nothing mid-turn.

## Scope

- User bubbles right, agent replies left, rendered as Markdown with code styling.
- Live "Working · …" line while a turn runs (latest preamble text).
- Under each final reply: a tool-call count chip that jumps to that turn in the tool log.
- Stick to bottom while streaming unless the user scrolled up.

## Acceptance criteria

- [ ] No preamble or tool output appears in the chat.
- [ ] Matches `task-workspace.png` and `02-agent-working.png`.

## Design

![task-workspace](../../design/screens/task-workspace.png)
![02-agent-working](../../design/screens/02-agent-working.png)

## Depends on

P1-05
