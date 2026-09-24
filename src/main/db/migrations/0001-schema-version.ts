import type { Migration } from '../migrate'

/** Creates the table the migration runner records applied versions in. */
export const schemaVersionMigration: Migration = {
  version: 1,
  name: 'Create the schema version table',
  up(db) {
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT
    `)
  },
}
