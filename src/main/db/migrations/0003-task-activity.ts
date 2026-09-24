import type { Migration } from '../migrate'

/**
 * Adds each task's activity: what its agent is doing (`TaskActivity` in `src/shared/domain.ts`). Existing tasks start
 * out waiting on you.
 */
export const taskActivityMigration: Migration = {
  version: 3,
  name: 'Add the task activity',
  up(db) {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN activity TEXT NOT NULL DEFAULT 'waiting'
        CHECK (activity IN ('waiting', 'working', 'error'))
    `)
  },
}
