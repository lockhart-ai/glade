import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { pluginSettingsMigration } from './0053-plugin-settings'

it('is migration 53, after every earlier one', () => {
  expect(pluginSettingsMigration.version).toBe(53)
  expect(MIGRATIONS.indexOf(pluginSettingsMigration)).toBe(MIGRATIONS.filter((m) => m.version < 53).length)
})

it('starts with nothing chosen, keeps one value per plugin and key, and goes with the plugin', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS)
  db.prepare("INSERT INTO plugins (id, enabled, found_at) VALUES ('sketchpad', 1, 1)").run()

  expect(db.prepare('SELECT COUNT(*) FROM plugin_settings').pluck().get()).toBe(0)
  const choose = db.prepare(
    "INSERT INTO plugin_settings (plugin_id, key, value, updated_at) VALUES ('sketchpad', 'style', ?, 2)",
  )
  choose.run('ink')
  expect(() => choose.run('chalk')).toThrow(/UNIQUE/)
  expect(() =>
    db
      .prepare("INSERT INTO plugin_settings (plugin_id, key, value, updated_at) VALUES ('nothing', 'style', 'ink', 2)")
      .run(),
  ).toThrow(/FOREIGN KEY/)

  db.prepare("DELETE FROM plugins WHERE id = 'sketchpad'").run()
  expect(db.prepare('SELECT COUNT(*) FROM plugin_settings').pluck().get()).toBe(0)
  db.close()
})
