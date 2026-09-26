import type { Database } from 'better-sqlite3'

/**
 * One forward-only step in the database schema. Versions start at 1 and go up; a migration is never edited or removed
 * once it has shipped. A version can be held for a branch that hasn't landed yet, so the list can skip numbers, and a
 * migration that lands below one a database already has still runs there (see `migrate`).
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

/** The version a database is at once `migrations` have run: the highest of them, or 0 when there are none. */
export function latestVersion(migrations: readonly Migration[]): number {
  return migrations.at(-1)?.version ?? 0
}

/** The versions applied to `db`: none for a fresh database. */
function appliedVersions(db: Database): ReadonlySet<number> {
  if (schemaVersion(db) === 0) return new Set()
  const versions = db.prepare(`SELECT version FROM ${SCHEMA_VERSION_TABLE}`).pluck().all() as number[]
  return new Set(versions)
}

/** Throws unless the list starts at 1 and each version is higher than the one before (skipping numbers is fine). */
function checkOrder(migrations: readonly Migration[]): void {
  let previous = 0
  migrations.forEach((migration, index) => {
    if (previous === 0 ? migration.version !== 1 : migration.version <= previous) {
      throw new Error(
        `Migrations must start at 1 and go up: position ${String(index + 1)} has version ${String(migration.version)}`,
      )
    }
    previous = migration.version
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
 * Brings `db` up to the latest of `migrations`. A migration is pending when its version isn't recorded in `db`, so one
 * that lands after a higher-numbered one (its number was held while it was on a branch) still runs on a database that
 * already has the higher one. Each pending migration runs in its own transaction together with its bookkeeping row, so
 * a migration that throws rolls back completely and leaves the version where it was (earlier migrations in the same
 * call stay applied). Running it again on a current database does nothing.
 */
export function migrate(db: Database, migrations: readonly Migration[]): MigrationResult {
  checkOrder(migrations)

  const fromVersion = schemaVersion(db)
  const latest = latestVersion(migrations)
  if (fromVersion > latest) {
    throw new Error(
      `The database is at schema version ${String(fromVersion)}, newer than this app knows (${String(latest)})`,
    )
  }

  const done = appliedVersions(db)
  const applied: number[] = []
  for (const migration of migrations.filter((m) => !done.has(m.version))) {
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
