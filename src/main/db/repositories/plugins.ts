import type { Database } from 'better-sqlite3'
import { isPluginCapability, type PluginCapability } from '../../../shared/plugins'
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

/**
 * The capabilities you've turned on for each plugin, by id: only plugins with at least one. A capability this Glade
 * doesn't know (a newer one's, before a downgrade) is left out.
 */
export function getPluginGrants(db: Database): ReadonlyMap<string, ReadonlySet<PluginCapability>> {
  const grants = new Map<string, Set<PluginCapability>>()
  for (const raw of db.prepare('SELECT plugin_id, capability FROM plugin_grants').all()) {
    const row = new Row('plugin_grants', raw)
    const capability = row.text('capability')
    if (!isPluginCapability(capability)) continue
    const id = row.text('plugin_id')
    const granted = grants.get(id) ?? new Set<PluginCapability>()
    granted.add(capability)
    grants.set(id, granted)
  }
  return grants
}

/** Turns a capability on or off for a plugin, which must already have its row (`notePluginsFound`). */
export function setPluginGrant(
  db: Database,
  id: string,
  capability: PluginCapability,
  granted: boolean,
  now = Date.now(),
): void {
  if (granted) {
    db.prepare(
      'INSERT INTO plugin_grants (plugin_id, capability, granted_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
    ).run(id, capability, now)
  } else {
    db.prepare('DELETE FROM plugin_grants WHERE plugin_id = ? AND capability = ?').run(id, capability)
  }
}

/**
 * The values you've chosen for each plugin's settings, by plugin id and then setting key: only plugins with at least
 * one. As saved: a value its plugin no longer offers is still here, and reads as the default (`settingValues`).
 */
export function getPluginSettings(db: Database): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const settings = new Map<string, Map<string, string>>()
  for (const raw of db.prepare('SELECT plugin_id, key, value FROM plugin_settings').all()) {
    const row = new Row('plugin_settings', raw)
    const id = row.text('plugin_id')
    const chosen = settings.get(id) ?? new Map<string, string>()
    chosen.set(row.text('key'), row.text('value'))
    settings.set(id, chosen)
  }
  return settings
}

/** Saves the value chosen for one of a plugin's settings; the plugin must already have its row (`notePluginsFound`). */
export function setPluginSetting(db: Database, id: string, key: string, value: string, now = Date.now()): void {
  db.prepare(
    `INSERT INTO plugin_settings (plugin_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (plugin_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(id, key, value, now)
}

/** Turns a plugin on or off. */
export function setPluginEnabled(db: Database, id: string, enabled: boolean, now = Date.now()): void {
  db.prepare(
    'INSERT INTO plugins (id, enabled, found_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled',
  ).run(id, enabled ? 1 : 0, now)
}
