import type { Migration } from '../migrate'

/**
 * Adds the capabilities you've turned on for each plugin in Settings › Plugins (#403, `docs/plugin-api.md`,
 * "Capabilities"): a row per plugin and capability that's on, none while it's off, so every capability starts off. A
 * plugin's rows go with its row in `plugins` (which stays when its folder is removed, so one that comes back is as you
 * left it).
 */
export const pluginGrantsMigration: Migration = {
  version: 48,
  name: 'Add the capabilities turned on for plugins',
  up(db) {
    db.exec(`
      CREATE TABLE plugin_grants (
        plugin_id TEXT NOT NULL REFERENCES plugins (id) ON DELETE CASCADE,
        capability TEXT NOT NULL,
        granted_at INTEGER NOT NULL,
        PRIMARY KEY (plugin_id, capability)
      ) STRICT;
    `)
  },
}
