import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { sampleTask, sampleWorkspace } from '../repositories/test-database'
import { MIGRATIONS } from '.'

it('adds a worktree to each dispatched child, none for the ones already there', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter(({ version }) => version <= 66),
  )
  const task = sampleTask(db, sampleWorkspace(db).id)
  db.prepare(
    "INSERT INTO managed_agents (id, task_id, tool_use_id, model, session_id, state, result) VALUES ('child', ?, 'dispatch', 'sonnet', 'session', 'completed', 'Done')",
  ).run(task.id)
  migrate(db, MIGRATIONS)
  expect(db.prepare("SELECT worktree FROM managed_agents WHERE id = 'child'").get()).toEqual({ worktree: null })
  db.prepare("UPDATE managed_agents SET worktree = 'glade-child-sample' WHERE id = 'child'").run()
  expect(db.prepare("SELECT worktree FROM managed_agents WHERE id = 'child'").get()).toEqual({
    worktree: 'glade-child-sample',
  })
  db.close()
})
