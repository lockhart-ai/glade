import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { sampleTask, sampleWorkspace } from '../repositories/test-database'
import { MIGRATIONS } from '.'
import { taskBackfillsMigration } from './0026-task-backfills'

it('is migration 26', () => {
  expect(MIGRATIONS[25]).toBe(taskBackfillsMigration)
})

it('keeps one row per task, a unique external id, a handoff of at most 32 KB with its time, and goes with its task', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS.slice(0, 25))
  migrate(db, MIGRATIONS)
  const workspace = sampleWorkspace(db)
  const [t1, t2, t3] = [1, 2, 3].map(() => sampleTask(db, workspace.id).id)

  const insert = db.prepare(
    'INSERT INTO task_backfills (task_id, external_id, handoff, handoff_at) VALUES (@taskId, @externalId, @handoff, @at)',
  )
  insert.run({ taskId: t1, externalId: 'notes/a', handoff: 'é'.repeat(16_384), at: 2 })
  expect(() => insert.run({ taskId: t1, externalId: null, handoff: null, at: null })).toThrow(/UNIQUE/)
  expect(() => insert.run({ taskId: t2, externalId: 'notes/a', handoff: null, at: null })).toThrow(/UNIQUE/)
  // Two bytes each: one over 32 KB.
  expect(() => insert.run({ taskId: t2, externalId: null, handoff: `${'é'.repeat(16_384)}a`, at: 2 })).toThrow(
    /CHECK/,
  )
  expect(() => insert.run({ taskId: t2, externalId: null, handoff: 'Notes', at: null })).toThrow(/CHECK/)
  expect(() => insert.run({ taskId: t2, externalId: null, handoff: null, at: 2 })).toThrow(/CHECK/)
  // Tasks without an external id don't clash.
  insert.run({ taskId: t2, externalId: null, handoff: 'Notes', at: 2 })
  insert.run({ taskId: t3, externalId: null, handoff: null, at: null })
  expect(() => insert.run({ taskId: 'gone', externalId: null, handoff: null, at: null })).toThrow(/FOREIGN KEY/)

  db.prepare('DELETE FROM tasks WHERE id = ?').run(t1)
  expect(db.prepare('SELECT task_id FROM task_backfills').pluck().all().sort()).toEqual([t2, t3].sort())
  db.close()
})
