import type { Migration } from '../migrate'

/**
 * Creates the core tables: workspaces, tasks, and each task's chat messages and tool log, plus the UI state.
 *
 * - Times are epoch milliseconds (INTEGER); ids are UUIDs (TEXT); booleans are 0/1 INTEGERs.
 * - Enum columns carry CHECK constraints with the values of the matching enum in `src/shared/domain.ts`.
 * - Messages and tool events are ordered by `seq`, numbered 1, 2, 3, … per task as they're appended. An explicit
 *   column, because `created_at` can tie and SQLite's rowid can change on VACUUM.
 * - Tool events keep each variant's fields in their own nullable columns, with a CHECK per kind saying which are set,
 *   rather than in a JSON payload. There are only three small, fixed variants; this way SQLite enforces their shape,
 *   and a tool call can be found by its `tool_use_id` (unique per task) to fill in its result. `tool_input` is the one
 *   JSON column: the tool's input object, whose shape depends on the tool.
 * - `ui_state.key` has no CHECK: keys are added as features need them, and a CHECK would mean rebuilding the table
 *   each time. The repository only accepts `UiStateKey` values.
 */
export const coreTablesMigration: Migration = {
  version: 2,
  name: 'Create workspaces, tasks, messages, tool events and UI state',
  up(db) {
    db.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_opened_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'done')),
        pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
        unread INTEGER NOT NULL CHECK (unread IN (0, 1)),
        model TEXT NOT NULL,
        effort TEXT NOT NULL CHECK (effort IN ('low', 'medium', 'high', 'max')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        done_at INTEGER,
        session_id TEXT,
        -- A task has a done time exactly when it's done.
        CHECK ((state = 'done') = (done_at IS NOT NULL))
      ) STRICT;

      CREATE INDEX tasks_by_workspace ON tasks (workspace_id, updated_at);

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'agent')),
        body TEXT NOT NULL,
        turn INTEGER NOT NULL CHECK (turn >= 1),
        created_at INTEGER NOT NULL,
        UNIQUE (task_id, seq)
      ) STRICT;

      CREATE TABLE tool_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('narration', 'tool_call', 'divider')),
        turn INTEGER NOT NULL CHECK (turn >= 1),
        created_at INTEGER NOT NULL,
        -- narration
        text TEXT,
        -- tool_call
        tool_name TEXT,
        tool_input TEXT CHECK (tool_input IS NULL OR (json_valid(tool_input) AND json_type(tool_input) = 'object')),
        tool_output TEXT,
        tool_state TEXT CHECK (tool_state IN ('running', 'done', 'error')),
        tool_use_id TEXT,
        parent_tool_use_id TEXT,
        -- divider
        divider_kind TEXT CHECK (divider_kind IN ('turn', 'marked_done', 'reopened', 'resumed')),
        UNIQUE (task_id, seq),
        UNIQUE (task_id, tool_use_id),
        CHECK (kind != 'narration' OR (
          text IS NOT NULL
          AND tool_name IS NULL AND tool_input IS NULL AND tool_output IS NULL AND tool_state IS NULL
          AND tool_use_id IS NULL AND parent_tool_use_id IS NULL AND divider_kind IS NULL
        )),
        CHECK (kind != 'tool_call' OR (
          tool_name IS NOT NULL AND tool_input IS NOT NULL AND tool_state IS NOT NULL AND tool_use_id IS NOT NULL
          AND text IS NULL AND divider_kind IS NULL
        )),
        CHECK (kind != 'divider' OR (
          divider_kind IS NOT NULL
          AND text IS NULL AND tool_name IS NULL AND tool_input IS NULL AND tool_output IS NULL AND tool_state IS NULL
          AND tool_use_id IS NULL AND parent_tool_use_id IS NULL
        ))
      ) STRICT;

      CREATE TABLE ui_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `)
  },
}
