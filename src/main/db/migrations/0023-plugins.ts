import type { Migration } from '../migrate'

/**
 * Adds the plugins' enabled state (`docs/plugin-api.md`): one row per plugin Glade has found, by its id, saying whether
 * it's turned on in Settings › Plugins. A plugin gets its row, enabled, the first time it's found; the row stays when
 * its folder is removed, so a plugin that comes back is as you left it.
 */
export const pluginsMigration: Migration = {
  version: 23,
  name: 'Add the plugins',
  up(db) {
    db.exec(`
      CREATE TABLE plugins (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        found_at INTEGER NOT NULL
      ) STRICT;
    `)
  },
}
