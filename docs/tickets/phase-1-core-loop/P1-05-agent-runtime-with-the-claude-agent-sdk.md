---
id: P1-05
title: "P1-05: Agent runtime with the Claude Agent SDK"
milestone: "P1 · Core loop"
labels: [phase-1, agent]
depends_on: [P1-02, P0-04]
---

# P1-05: Agent runtime with the Claude Agent SDK

Run a Claude agent session per task in the main process and persist everything it emits.

## Scope

- One SDK session per task; cwd = the task folder; permissions = allow all; model and effort from the input bar.
- System prompt tells the agent about its task folder and CLAUDE.md notes (see `docs/model-surface.md`).
- Persist every event: final replies to `messages`; tool calls, results and preamble text to `tool_events` with turn numbers.
- Store the SDK session id so the session can resume (P1-12).
- Auth: the user's Claude subscription via their Claude Code login if the SDK allows it; API key fallback.
- Stop interrupts the current turn cleanly.

## Acceptance criteria

- [ ] A prompt produces a streamed reply and tool events in the DB.
- [ ] Stop halts the agent within a second.
- [ ] Integration test with a mocked SDK stream.

## Depends on

P1-02, P0-04
