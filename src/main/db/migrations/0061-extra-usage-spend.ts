import type { Migration } from '../migrate'

/**
 * Keeps what the usage call says of extra usage with its reading (#530; `ExtraUsageStatus` in
 * `src/shared/account.ts`), so the usage meter shows the money spent again after a relaunch:
 *
 * - `extra_available`: whether extra usage can take the requests a plan limit turns away (0 or 1). Null for every other
 *   limit, and for extra usage until a usage call has told of it.
 * - `spent` and `spend_cap`: what's been spent this month and the monthly cap, in the currency's minor units (cents);
 *   `spend_currency`, its ISO 4217 code, and `spend_decimal_places`, how many decimal places it has. All null when the
 *   call gave no amount Glade can show; the cap alone is null when there's none.
 *
 * Readings saved before this have none of it: the next usage call fills them in.
 */
export const extraUsageSpendMigration: Migration = {
  version: 61,
  name: 'Keep the money spent on extra usage with its reading',
  up(db) {
    db.exec(`
      ALTER TABLE usage_readings ADD COLUMN extra_available INTEGER
        CHECK (extra_available IS NULL OR (kind = 'extra_usage' AND extra_available IN (0, 1)));
      ALTER TABLE usage_readings ADD COLUMN spent REAL
        CHECK (spent IS NULL OR (extra_available IS NOT NULL AND spent >= 0));
      ALTER TABLE usage_readings ADD COLUMN spend_cap REAL
        CHECK (spend_cap IS NULL OR (spent IS NOT NULL AND spend_cap >= 0));
      ALTER TABLE usage_readings ADD COLUMN spend_currency TEXT
        CHECK ((spend_currency IS NULL) = (spent IS NULL));
      ALTER TABLE usage_readings ADD COLUMN spend_decimal_places INTEGER
        CHECK ((spend_decimal_places IS NULL) = (spent IS NULL) AND ifnull(spend_decimal_places, 0) >= 0);
    `)
  },
}
