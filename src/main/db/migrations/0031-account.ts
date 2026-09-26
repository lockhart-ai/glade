import type { Migration } from '../migrate'

/**
 * Adds the account the tasks run on and the warning while it's close to a usage limit (`src/shared/account.ts`), each
 * one row at most: the account as Claude Code last reported it (the SDK's `accountInfo()`, its fields as given, null
 * where it left one out), and the warning until its window resets or the SDK says the limit is fine again. Kept so
 * Settings › General and the note show them again after a relaunch, before any task has started.
 */
export const accountMigration: Migration = {
  version: 31,
  name: 'Add the account and its usage warning',
  up(db) {
    db.exec(`
      CREATE TABLE account (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        email TEXT,
        organization TEXT,
        subscription_type TEXT,
        token_source TEXT,
        api_key_source TEXT,
        api_provider TEXT,
        read_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE usage_warning (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        utilization REAL CHECK (utilization IS NULL OR utilization >= 0),
        usage_window TEXT NOT NULL
          CHECK (usage_window IN ('five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'other')),
        resets_at INTEGER
      ) STRICT;
    `)
  },
}
