import type { Database } from 'better-sqlite3'
import type { Migration } from '../migrate'

/**
 * Adds `session_context.external_id` (#751): the task's external id a session was told, in its prompt when Glade
 * started it or as a block ahead of a message when it was set or changed since. Without it, a session that started
 * before its task's external id existed, or before it changed, keeps naming the value it was told, or none, forever:
 * a resumed session keeps the prompt it started with, and a task's `session_id` is never cleared, so no later session
 * starts afresh to pick the new value up.
 *
 * Nothing is backfilled: every session recorded here predates the line, so it was told none, whatever its task has
 * now — and a task whose external id is set is owed the line once, as a block, through the ordinary "changed" path.
 */
export const externalIdToldMigration: Migration = {
  version: 84,
  name: 'Add the external id a session was told',
  up(db: Database) {
    db.exec('ALTER TABLE session_context ADD COLUMN external_id TEXT')
  },
}
