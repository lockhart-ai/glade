---
id: P1-11
title: "P1-11: Mark done, Undo, and reopen by chatting"
milestone: "P1 · Core loop"
labels: [phase-1, feature]
depends_on: [P1-09, P1-10]
---

# P1-11: Mark done, Undo, and reopen by chatting

Finishing a task and picking it back up.

## Scope

- Mark done: no dialog; state → done, outcome = current status; the row moves to Done; Undo toast for a few seconds.
- Done tasks keep the input bar with the placeholder "Send a message to reopen this task…".
- Sending a message in a done task reopens it (state → active) and adds "Marked done" / "Reopened" dividers to the chat and the log.

## Acceptance criteria

- [ ] Mark done → Undo restores the task exactly.
- [ ] Reopen resumes the same agent session with its history.

## Design

![05-mark-done](../../design/screens/05-mark-done.png)
![06-reopen](../../design/screens/06-reopen.png)

## Depends on

P1-09, P1-10
