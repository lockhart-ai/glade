import { expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { getSettings } from '../repositories/settings'
import { MIGRATIONS } from '.'
import { settingsMigration } from './0017-settings'

it('is migration 17', () => {
  expect(MIGRATIONS[16]).toBe(settingsMigration)
})

it('starts with every setting at its default, and keeps one row per setting', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS.slice(0, 16))

  migrate(db, MIGRATIONS)

  expect(getSettings(db)).toEqual(DEFAULT_SETTINGS)
  const insert = db.prepare("INSERT INTO settings VALUES ('notifications', 'false')")
  insert.run()
  expect(() => insert.run()).toThrow(/UNIQUE/)
  db.close()
})
