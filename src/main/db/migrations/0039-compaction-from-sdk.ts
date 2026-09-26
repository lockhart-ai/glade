import type { Migration } from '../migrate'

/**
 * Takes compaction from the SDK (#279): each task keeps where the SDK says it compacts automatically (`auto_compact`,
 * JSON, `AutoCompact` in `src/shared/domain.ts`; null until the SDK says), and each compaction keeps the summary it
 * wrote (`compact_summary`), which only a compaction has.
 */
export const compactionFromSdkMigration: Migration = {
  version: 39,
  name: 'Keep the auto-compact threshold and compaction summaries from the SDK',
  up(db) {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN auto_compact TEXT
        CHECK (auto_compact IS NULL OR (json_valid(auto_compact) AND json_type(auto_compact) = 'object'));
      ALTER TABLE tool_events ADD COLUMN compact_summary TEXT
        CHECK (compact_summary IS NULL OR kind = 'compaction');
    `)
  },
}
