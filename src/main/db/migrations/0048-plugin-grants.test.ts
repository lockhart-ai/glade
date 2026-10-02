import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { pluginGrantsMigration } from './0048-plugin-grants'

it('is migration 48, after every earlier one', () => {
  expect(pluginGrantsMigration.version).toBe(48)
  expect(MIGRATIONS.indexOf(pluginGrantsMigration)).toBe(MIGRATIONS.filter((m) => m.version < 48).length)
})

it("starts every plugin's capabilities off, keeps one row per plugin and capability, and goes with the plugin", () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS)
  db.prepare("INSERT INTO plugins (id, enabled, found_at) VALUES ('gauge', 1, 1)").run()

  expect(db.prepare('SELECT COUNT(*) FROM plugin_grants').pluck().get()).toBe(0)
  const grant = db.prepare(
    "INSERT INTO plugin_grants (plugin_id, capability, granted_at) VALUES ('gauge', 'machine', 2)",
  )
  grant.run()
  expect(() => grant.run()).toThrow(/UNIQUE/)
  expect(() =>
    db.prepare("INSERT INTO plugin_grants (plugin_id, capability, granted_at) VALUES ('nothing', 'machine', 2)").run(),
  ).toThrow(/FOREIGN KEY/)

  db.prepare("DELETE FROM plugins WHERE id = 'gauge'").run()
  expect(db.prepare('SELECT COUNT(*) FROM plugin_grants').pluck().get()).toBe(0)
  db.close()
})
