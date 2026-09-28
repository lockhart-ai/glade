import type { Migration } from '../migrate'

/**
 * Replaces the usage warning with the usage meter's readings (`src/shared/account.ts`): the latest reading of each usage
 * limit Claude Code has told of, one row per limit (a per-model weekly limit keeps its model's name in `model`, which
 * is empty for the others), with when it was read. Kept so the meter shows them again after a relaunch, until each
 * window resets.
 *
 * The warning isn't carried over: it only stood while a limit was close, and the next turn reads the limits afresh.
 */
export const usageReadingsMigration: Migration = {
  version: 42,
  name: 'Replace the usage warning with a reading per usage limit',
  up(db) {
    db.exec(`
      DROP TABLE usage_warning;

      CREATE TABLE usage_readings (
        kind TEXT NOT NULL CHECK (kind IN ('session', 'weekly', 'weekly_model', 'extra_usage')),
        model TEXT NOT NULL DEFAULT '' CHECK ((kind = 'weekly_model') = (model <> '')),
        utilization REAL CHECK (utilization IS NULL OR utilization >= 0),
        resets_at INTEGER,
        level TEXT NOT NULL CHECK (level IN ('within', 'warning', 'limited')),
        read_at INTEGER NOT NULL,
        PRIMARY KEY (kind, model)
      ) STRICT;
    `)
  },
}
