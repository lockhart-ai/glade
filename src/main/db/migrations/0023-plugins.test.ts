import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { getPluginStates } from '../repositories/plugins'
import { MIGRATIONS } from '.'
import { pluginsMigration } from './0023-plugins'

it('is migration 23', () => {
  expect(MIGRATIONS[22]).toBe(pluginsMigration)
})

it('starts with no plugins, keeps one row per plugin, and checks the enabled flag', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS.slice(0, 22))

  migrate(db, MIGRATIONS)

  expect(getPluginStates(db)).toEqual(new Map())
  const insert = db.prepare("INSERT INTO plugins (id, enabled, found_at) VALUES ('pomodoro', 1, 1)")
  insert.run()
  expect(() => insert.run()).toThrow(/UNIQUE/)
  expect(() => db.prepare("INSERT INTO plugins (id, enabled, found_at) VALUES ('abacus', 2, 1)").run()).toThrow(/CHECK/)
  db.close()
})
