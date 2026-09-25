import type { Database } from 'better-sqlite3'
import { Row } from './rows'

/**
 * Whether each plugin Glade has found is turned on, by id: every plugin found so far, including any whose folder has
 * since been removed.
 */
export function getPluginStates(db: Database): ReadonlyMap<string, boolean> {
  const states = new Map<string, boolean>()
  for (const raw of db.prepare('SELECT id, enabled FROM plugins').all()) {
    const row = new Row('plugins', raw)
    states.set(row.text('id'), row.flag('enabled'))
  }
  return states
}

/** Notes the plugins found: one found for the first time is turned on. One found before keeps its state. */
export function notePluginsFound(db: Database, ids: readonly string[], now = Date.now()): void {
  const insert = db.prepare('INSERT INTO plugins (id, enabled, found_at) VALUES (?, 1, ?) ON CONFLICT (id) DO NOTHING')
  db.transaction(() => {
    for (const id of ids) insert.run(id, now)
  })()
}

/** Turns a plugin on or off. */
export function setPluginEnabled(db: Database, id: string, enabled: boolean, now = Date.now()): void {
  db.prepare(
    'INSERT INTO plugins (id, enabled, found_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled',
  ).run(id, enabled ? 1 : 0, now)
}
