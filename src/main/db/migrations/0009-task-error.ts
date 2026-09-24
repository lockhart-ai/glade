import type { Migration } from '../migrate'

/**
 * Adds what stopped each task's agent (`TaskError` in `src/shared/domain.ts`), shown on the chat's error card, and the
 * automatic API retry in progress (`ApiRetry`), shown on the working line. Each is a JSON object, or null when there's
 * none; the tasks repository parses them. Existing tasks have neither.
 */
export const taskErrorMigration: Migration = {
  version: 9,
  name: 'Add the task error and API retry',
  up(db) {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN error TEXT CHECK (error IS NULL OR (json_valid(error) AND json_type(error) = 'object'));
      ALTER TABLE tasks ADD COLUMN retrying TEXT
        CHECK (retrying IS NULL OR (json_valid(retrying) AND json_type(retrying) = 'object'));
    `)
  },
}
