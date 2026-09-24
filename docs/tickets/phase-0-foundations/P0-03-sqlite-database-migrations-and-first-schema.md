---
id: P0-03
title: "P0-03: SQLite database, migrations and first schema"
milestone: "P0 · Foundations"
labels: [phase-0, data]
depends_on: [P0-01]
---

# P0-03: SQLite database, migrations and first schema

All app state lives in SQLite so the app can crash and resume.

## Scope

- Proposed: better-sqlite3 in the main process, WAL mode, stored in the app's data folder.
- A forward-only migration runner with a schema version table.
- First schema (adjust as needed): `workspaces` (id, name, root, created, last_opened), `tasks` (id, workspace_id, title, objective, status, state active|done, pinned, unread, created, updated, done_at, folder, sdk_session_id), `messages` (id, task_id, role user|agent, body, turn, created), `tool_events` (id, task_id, turn, kind narration|tool|divider, name, input, output, state, created), `ui_state` (key, value).
- A small repository layer with tests; no SQL in the renderer.

## Acceptance criteria

- [ ] Migrations run on launch and are idempotent.
- [ ] Repository functions are covered by tests against a temp DB.
- [ ] Killing the app mid-write leaves the database consistent.

## Depends on

P0-01
