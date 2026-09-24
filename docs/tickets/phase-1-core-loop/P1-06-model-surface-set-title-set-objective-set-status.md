---
id: P1-06
title: "P1-06: Model surface: set_title, set_objective, set_status"
milestone: "P1 · Core loop"
labels: [phase-1, agent]
depends_on: [P1-05]
---

# P1-06: Model surface: set_title, set_objective, set_status

The first app tools the model uses to drive the UI.

## Scope

- In-process MCP server registered with the SDK session.
- `set_title`, `set_objective`, `set_status` update the task row and push events to the renderer.
- Prompting so the agent calls title and objective after the first message and keeps status current each turn.

## Acceptance criteria

- [ ] After a first message the header and sidebar show the agent's title, objective and status.
- [ ] Tool calls appear in the tool log like any other tool.

## Design

![01-new-task](../../design/screens/01-new-task.png)
![02-agent-working](../../design/screens/02-agent-working.png)

## Depends on

P1-05
