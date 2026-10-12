import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { openRouterManagementMigration } from './0068-openrouter-management'

it('adds the management key and guardrails columns without disturbing the connection', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter(({ version }) => version < 68),
  )
  db.prepare('INSERT INTO openrouter_connection VALUES (1, ?, ?, ?)').run(Buffer.from('encrypted'), '[]', '[]')
  expect(openRouterManagementMigration.version).toBe(68)
  migrate(db, MIGRATIONS)
  // The key and the guardrails start absent: no management key connected, no known restriction.
  expect(
    db.prepare('SELECT encrypted_key, encrypted_management_key, guardrail_providers FROM openrouter_connection').get(),
  ).toEqual({
    encrypted_key: Buffer.from('encrypted'),
    encrypted_management_key: null,
    guardrail_providers: null,
  })
})
