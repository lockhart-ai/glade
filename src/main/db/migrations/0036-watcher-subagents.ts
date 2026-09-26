import type { Migration } from '../migrate'

/**
 * Gives each watcher the subagent it belongs to (#291): `parent_tool_use_id` is the `Agent` call of the subagent whose
 * call started it, or null for the task's own. Existing ones take it from the call that started them.
 *
 * It also drops the watchers that never were: the SDK starts a task for a foreground `Bash` call that runs for a few
 * seconds too (`docs/sdk-notes.md`, "Background work inside a subagent"), and each one became a command watcher, most of
 * them a subagent's. A foreground call is its own tool call, not something left running, so its row goes, unless the
 * call ran past its timeout and the SDK moved it to the background, which its result says.
 */
export const watcherSubagentsMigration: Migration = {
  version: 36,
  name: "Attribute watchers to their subagents, and drop foreground commands'",
  up(db) {
    db.exec(`
      ALTER TABLE watchers ADD COLUMN parent_tool_use_id TEXT;

      UPDATE watchers SET parent_tool_use_id = (
        SELECT call.parent_tool_use_id FROM tool_events call
        WHERE call.task_id = watchers.task_id AND call.tool_use_id = watchers.tool_use_id
      );

      DELETE FROM watchers
      WHERE kind = 'command' AND EXISTS (
        SELECT 1 FROM tool_events call
        WHERE call.task_id = watchers.task_id
          AND call.tool_use_id = watchers.tool_use_id
          AND call.kind = 'tool_call'
          AND call.tool_name = 'Bash'
          AND coalesce(json_extract(call.tool_input, '$.run_in_background'), 0) != 1
          AND instr(coalesce(call.tool_output, ''), 'moved to the background') = 0
      );
    `)
  },
}
