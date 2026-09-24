import type { Migration } from '../migrate'

/**
 * Adds the settings (`Settings` in `src/shared/settings.ts`): one row per setting you've changed, its value as JSON.
 * A setting with no row has its default, so a new setting needs no migration. Like `ui_state.key`, `key` has no CHECK;
 * the repository only reads the keys it knows.
 */
export const settingsMigration: Migration = {
  version: 17,
  name: 'Add the settings',
  up(db) {
    db.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `)
  },
}
