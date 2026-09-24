import type { Migration } from '../migrate'

/**
 * Adds when each task's status last changed, which the task header shows ("· 4m ago"). `updated_at` moves with every
 * change to a task (its activity, its pin), so it can't stand in. Existing tasks with a status take their `updated_at`
 * as the nearest known time; tasks without one get null.
 */
export const statusUpdatedAtMigration: Migration = {
  version: 4,
  name: 'Add when the task status changed',
  up(db) {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN status_updated_at INTEGER;
      UPDATE tasks SET status_updated_at = updated_at WHERE status != '';
    `)
  },
}
