import type { Migration } from '../migrate'

/**
 * Adds the values you've chosen for each plugin's settings in Settings › Plugins (#435, `docs/plugin-api.md`,
 * "Settings"): a row per plugin and setting key once you choose one, none while it's at its default. A value the
 * plugin no longer offers stays as saved and reads as the default. A plugin's rows go with its row in `plugins` (which
 * stays when its folder is removed or replaced, so an updated plugin, or one that comes back, is as you left it).
 */
export const pluginSettingsMigration: Migration = {
  version: 53,
  name: 'Add the values chosen for plugin settings',
  up(db) {
    db.exec(`
      CREATE TABLE plugin_settings (
        plugin_id TEXT NOT NULL REFERENCES plugins (id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (plugin_id, key)
      ) STRICT;
    `)
  },
}
