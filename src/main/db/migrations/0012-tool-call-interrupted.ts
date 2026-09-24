import type { Migration } from '../migrate'

/**
 * Adds the paused and interrupted tool call states (`ToolCallState` in `src/shared/domain.ts`): a call cut off by a
 * pause or by Glade quitting, which the tool log shows apart from a failed one. SQLite can't change a table's CHECK
 * constraints, so the table is rebuilt: copied into a new one with the new states, then swapped in. Nothing references
 * `tool_events`, so dropping the old one is safe. Existing calls keep their states.
 */
export const toolCallInterruptedMigration: Migration = {
  version: 12,
  name: 'Add the paused and interrupted tool call states',
  up(db) {
    db.exec(`
      CREATE TABLE tool_events_new (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('narration', 'tool_call', 'divider', 'compaction')),
        turn INTEGER NOT NULL CHECK (turn >= 1),
        created_at INTEGER NOT NULL,
        -- narration
        text TEXT,
        -- tool_call
        tool_name TEXT,
        tool_input TEXT CHECK (tool_input IS NULL OR (json_valid(tool_input) AND json_type(tool_input) = 'object')),
        tool_output TEXT,
        -- tool_call and compaction
        tool_state TEXT CHECK (tool_state IN ('running', 'done', 'error', 'paused', 'interrupted')),
        tool_use_id TEXT,
        parent_tool_use_id TEXT,
        -- divider
        divider_kind TEXT CHECK (divider_kind IN ('turn', 'marked_done', 'reopened', 'resumed')),
        -- compaction
        compact_trigger TEXT CHECK (compact_trigger IN ('manual', 'auto')),
        pre_tokens INTEGER CHECK (pre_tokens >= 0),
        post_tokens INTEGER CHECK (post_tokens >= 0),
        window_tokens INTEGER CHECK (window_tokens >= 0),
        UNIQUE (task_id, seq),
        UNIQUE (task_id, tool_use_id),
        CHECK (kind = 'compaction' OR (
          compact_trigger IS NULL AND pre_tokens IS NULL AND post_tokens IS NULL AND window_tokens IS NULL
        )),
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
        )),
        CHECK (kind != 'compaction' OR (
          compact_trigger IS NOT NULL AND tool_state IS NOT NULL AND window_tokens IS NOT NULL
          AND text IS NULL AND tool_name IS NULL AND tool_input IS NULL AND tool_output IS NULL
          AND tool_use_id IS NULL AND parent_tool_use_id IS NULL AND divider_kind IS NULL
        ))
      ) STRICT;

      INSERT INTO tool_events_new (id, task_id, seq, kind, turn, created_at, text, tool_name, tool_input, tool_output,
        tool_state, tool_use_id, parent_tool_use_id, divider_kind, compact_trigger, pre_tokens, post_tokens,
        window_tokens)
      SELECT id, task_id, seq, kind, turn, created_at, text, tool_name, tool_input, tool_output, tool_state,
        tool_use_id, parent_tool_use_id, divider_kind, compact_trigger, pre_tokens, post_tokens, window_tokens
      FROM tool_events;

      DROP TABLE tool_events;
      ALTER TABLE tool_events_new RENAME TO tool_events;
    `)
  },
}
