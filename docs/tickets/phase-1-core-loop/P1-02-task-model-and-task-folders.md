---
id: P1-02
title: "P1-02: Task model and task folders"
milestone: "P1 · Core loop"
labels: [phase-1, data]
depends_on: [P0-03, P1-01]
---

# P1-02: Task model and task folders

Tasks in the DB, each with a folder and a notes file on disk.

## Scope

- Creating a task writes a row and `.glade/tasks/<task>/CLAUDE.md` (a short template the agent will maintain).
- Folder name: a slug of the title once known, with the id for uniqueness; renaming the task does not move the folder.
- State is only `active` or `done`.

## Acceptance criteria

- [ ] Creating and marking tasks done round-trips through the DB and disk.
- [ ] Tests cover slugging and collisions.

## Design

![lifecycle](../../design/screens/lifecycle.png)

## Depends on

P0-03, P1-01
