import type { Database } from 'better-sqlite3'

/**
 * One forward-only step in the database schema. Versions start at 1 and go up by one; a migration is never edited or
 * removed once it has shipped.
 */
export interface Migration {
  readonly version: number
  /** A short description, recorded alongside the version. */
  readonly name: string
  /**
   * Whether the migration rebuilds a table that other tables reference, as changing a CHECK constraint needs (SQLite's
   * "other kinds of table schema changes"). It then runs with foreign keys off, or dropping the old table would cascade
   * its deletes into the tables that reference it; the foreign keys are checked before it commits.
   */
  readonly rebuildsReferencedTable?: boolean
  up(db: Database): void
}

/** What a `migrate` call did. `applied` lists the versions it ran, in order; empty when the database was current. */
export interface MigrationResult {
  readonly fromVersion: number
  readonly toVersion: number
  readonly applied: readonly number[]
}

/** The bookkeeping table: one row per applied migration. Migration 1 creates it. */
export const SCHEMA_VERSION_TABLE = 'schema_version'

/** The schema version of `db`: the highest applied migration, or 0 for a fresh database. */
export function schemaVersion(db: Database): number {
  const table = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .pluck()
    .get(SCHEMA_VERSION_TABLE)
  if (table === undefined) return 0
  const version = db.prepare(`SELECT MAX(version) FROM ${SCHEMA_VERSION_TABLE}`).pluck().get()
  return typeof version === 'number' ? version : 0
}

function checkOrder(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `Migrations must be numbered 1, 2, 3, … in order: position ${String(index + 1)} has version ${String(migration.version)}`,
      )
    }
  })
}

/** Throws if any row references a row that isn't there. */
function checkForeignKeys(db: Database): void {
  const violations = db.pragma('foreign_key_check') as unknown[]
  if (violations.length > 0) throw new Error(`${String(violations.length)} rows break a foreign key`)
}

/**
 * Runs `apply` with foreign keys off, then puts them back as they were. The pragma does nothing inside a transaction,
 * so it's set around one.
 */
function withoutForeignKeys(db: Database, apply: () => void): void {
  const enforced = db.pragma('foreign_keys', { simple: true }) === 1
  db.pragma('foreign_keys = OFF')
  try {
    apply()
  } finally {
    if (enforced) db.pragma('foreign_keys = ON')
  }
}

/**
 * Brings `db` up to the latest of `migrations`. Each pending migration runs in its own transaction together with its
 * bookkeeping row, so a migration that throws rolls back completely and leaves the version where it was (earlier
 * migrations in the same call stay applied). Running it again on a current database does nothing.
 */
export function migrate(db: Database, migrations: readonly Migration[]): MigrationResult {
  checkOrder(migrations)

  const fromVersion = schemaVersion(db)
  if (fromVersion > migrations.length) {
    throw new Error(
      `The database is at schema version ${String(fromVersion)}, newer than this app knows (${String(migrations.length)})`,
    )
  }

  const applied: number[] = []
  for (const migration of migrations.slice(fromVersion)) {
    const apply = db.transaction(() => {
      migration.up(db)
      if (migration.rebuildsReferencedTable === true) checkForeignKeys(db)
      db.prepare(`INSERT INTO ${SCHEMA_VERSION_TABLE} (version, name, applied_at) VALUES (?, ?, ?)`).run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      )
    })
    try {
      if (migration.rebuildsReferencedTable === true) withoutForeignKeys(db, apply)
      else apply()
    } catch (cause) {
      throw new Error(`Migration ${String(migration.version)} (${migration.name}) failed`, { cause })
    }
    applied.push(migration.version)
  }

  return { fromVersion, toVersion: schemaVersion(db), applied }
}
