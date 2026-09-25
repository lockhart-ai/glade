import type { Database } from 'better-sqlite3'
import type { EpochMs, PermissionRule, TaskPermissionRule } from '../../../shared/domain'
import { Row } from './rows'

/** A rule to grant a task. */
export interface NewTaskPermissionRule {
  readonly taskId: string
  readonly rule: PermissionRule
}

const TABLE = 'task_permission_rules'
const COLUMNS = 'task_id, tool_name, rule_content, created_at'

function parseTaskPermissionRule(raw: unknown): TaskPermissionRule {
  const row = new Row(TABLE, raw)
  const content = row.nullableText('rule_content')
  return {
    taskId: row.text('task_id'),
    rule: { toolName: row.text('tool_name'), ...(content === null ? {} : { ruleContent: content }) },
    createdAt: row.integer('created_at'),
  }
}

/**
 * Grants a task a permission rule (Allow for this task). A rule the task already has stays as it was, granted when it
 * first was. Answers with whether it was new.
 */
export function addTaskPermissionRule(
  db: Database,
  { taskId, rule }: NewTaskPermissionRule,
  now: EpochMs = Date.now(),
): boolean {
  const content = rule.ruleContent ?? ''
  const { changes } = db
    .prepare(`INSERT INTO ${TABLE} (${COLUMNS}) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`)
    .run(taskId, rule.toolName, content === '' ? null : content, now)
  return changes > 0
}

/** The permission rules granted a task, in the order they were first granted. */
export function listTaskPermissionRules(db: Database, taskId: string): TaskPermissionRule[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM ${TABLE} WHERE task_id = ? ORDER BY created_at, rowid`)
    .all(taskId)
    .map(parseTaskPermissionRule)
}
