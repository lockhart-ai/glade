import { expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { getSettings } from '../repositories/settings'
import { MIGRATIONS } from '.'
import { settingsMigration } from './0018-settings'

it('is migration 18', () => {
  expect(MIGRATIONS[17]).toBe(settingsMigration)
})

it('starts with every setting at its default, and keeps one row per setting', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS.slice(0, 17))

  migrate(db, MIGRATIONS)

  expect(getSettings(db)).toEqual(DEFAULT_SETTINGS)
  const insert = db.prepare("INSERT INTO settings VALUES ('notifications', 'false')")
  insert.run()
  expect(() => insert.run()).toThrow(/UNIQUE/)
  db.close()
})
