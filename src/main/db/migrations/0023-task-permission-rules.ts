import type { Migration } from '../migrate'

/**
 * Adds Allow for this task (`docs/decisions.md`, "Per-call permission review"): the permission rules granted per task
 * (`TaskPermissionRule` in `src/shared/domain.ts`), deleted with their task, one row per rule however often it's granted;
 * and, on each permission request, the rule it was allowed with (a JSON `PermissionRule`), null for any other answer.
 * A rule is a tool name and, optionally, its content (`Bash` with `npm test *`): null content covers the whole tool.
 */
export const taskPermissionRulesMigration: Migration = {
  version: 23,
  name: 'Add the permission rules granted per task',
  up(db) {
    db.exec(`
      CREATE TABLE task_permission_rules (
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL CHECK (tool_name <> ''),
        rule_content TEXT CHECK (rule_content IS NULL OR rule_content <> ''),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX task_permission_rules_by_task
        ON task_permission_rules (task_id, tool_name, ifnull(rule_content, ''));

      ALTER TABLE permission_requests ADD COLUMN granted_rule TEXT
        CHECK (granted_rule IS NULL OR (json_valid(granted_rule) AND json_type(granted_rule) = 'object'));
    `)
  },
}
