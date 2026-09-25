import type { Migration } from '../migrate'

/**
 * Adds per-call permission review (`docs/decisions.md`, "Per-call permission review"): each task's permission mode
 * (`PermissionMode` in `src/shared/domain.ts`), which existing tasks keep at Allow all, and the permission requests
 * (`PermissionRequest`), one row per tool call that waits on your OK. A request stays open until you answer it or it's
 * withdrawn, so one the app quit on is still open after a relaunch. Its input is a JSON object and its suggestions a
 * JSON array; the permission requests repository parses them.
 */
export const permissionRequestsMigration: Migration = {
  version: 22,
  name: 'Add the permission mode and permission requests',
  up(db) {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'allow_all'
        CHECK (permission_mode IN ('allow_all', 'ask_before_edits'));

      CREATE TABLE permission_requests (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        turn INTEGER NOT NULL,
        tool_use_id TEXT NOT NULL,
        agent_id TEXT,
        tool_name TEXT NOT NULL,
        input TEXT NOT NULL CHECK (json_valid(input) AND json_type(input) = 'object'),
        title TEXT,
        display_name TEXT,
        description TEXT,
        suggestions TEXT NOT NULL CHECK (json_valid(suggestions) AND json_type(suggestions) = 'array'),
        default_to_no INTEGER NOT NULL CHECK (default_to_no IN (0, 1)),
        suppress_always_allow_rule INTEGER NOT NULL CHECK (suppress_always_allow_rule IN (0, 1)),
        state TEXT NOT NULL CHECK (state IN ('open', 'allowed', 'denied', 'withdrawn')),
        deny_note TEXT,
        created_at INTEGER NOT NULL,
        closed_at INTEGER
      ) STRICT;
      CREATE INDEX permission_requests_by_task ON permission_requests (task_id, state);
    `)
  },
}
