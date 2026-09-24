---
id: P1-10
title: "P1-10: Input bar"
milestone: "P1 · Core loop"
labels: [phase-1, ui, feature]
depends_on: [P1-05]
---

# P1-10: Input bar

Where you talk to the agent and set its model.

## Scope

- Settings row: Model, Effort (Low/Medium/High/Max), Permissions (Allow all, fixed for now), context meter on the right (read-only ring + "38% · 76k / 200k").
- Textarea: ↵ send, ⇧↵ newline; Stop button while working; send button.
- Model and effort are per task and persist.

## Acceptance criteria

- [ ] Changing the model applies to the next turn.
- [ ] Context meter updates from SDK usage events.

## Design

![task-workspace](../../design/screens/task-workspace.png)
![02-agent-working](../../design/screens/02-agent-working.png)

## Depends on

P1-05
