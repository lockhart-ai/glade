import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { sampleLegacyTask, sampleWorkspace } from '../repositories/test-database'
import { MIGRATIONS } from '.'
import { openRouterMigration } from './0065-openrouter'

it('adds durable OpenRouter records without changing existing tasks or history', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter(({ version }) => version < 65),
  )
  sampleLegacyTask(db, sampleWorkspace(db).id)
  const before = db.prepare('SELECT id, model, session_id FROM tasks').get()
  expect(openRouterMigration.version).toBe(65)
  migrate(db, MIGRATIONS)
  expect(db.prepare('SELECT id, model, session_id FROM tasks').get()).toEqual(before)
  expect(db.prepare('SELECT encrypted_key FROM openrouter_connection').all()).toEqual([])
  expect(() =>
    db
      .prepare(
        "INSERT INTO sdk_transcript_failures (owner, session_id, task_id, reason) VALUES (?, ?, ?, 'mirror_error')",
      )
      .run('missing', 'session', 'missing'),
  ).toThrow(/FOREIGN KEY/)
  expect(() =>
    db
      .prepare('INSERT INTO openrouter_connection VALUES (2, ?, ?, ?, NULL, NULL)')
      .run(Buffer.from('encrypted'), '[]', '[]'),
  ).toThrow(/CHECK/)
  db.close()
})
