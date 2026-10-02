import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { runningToolCallsIndexMigration } from './0052-running-tool-calls-index'

it('is migration 52, after every earlier one', () => {
  expect(runningToolCallsIndexMigration.version).toBe(52)
  expect(MIGRATIONS.indexOf(runningToolCallsIndexMigration)).toBe(MIGRATIONS.filter((m) => m.version < 52).length)
})

it('lets a task be read with its background work without walking its whole tool log', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS)

  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT EXISTS (SELECT 1 FROM tool_events WHERE tool_events.task_id = tasks.id
        AND tool_events.kind = 'tool_call' AND tool_events.tool_state = 'running'
        AND tool_events.tool_name IN ('Agent', 'Task')) FROM tasks`,
    )
    .all()
  expect(JSON.stringify(plan)).toContain('tool_events_running')
  db.close()
})
