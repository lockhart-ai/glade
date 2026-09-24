import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate, schemaVersion, type Migration } from './migrate'
import { MIGRATIONS } from './migrations'
import { schemaVersionMigration } from './migrations/0001-schema-version'

function createTable(version: number, table: string): Migration {
  return {
    version,
    name: `Create ${table}`,
    up(db) {
      db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`)
    },
  }
}

/** A migration that does some work, then throws, so the test can check the work was rolled back. */
function failing(version: number): Migration {
  return {
    version,
    name: 'Fail halfway',
    up(db) {
      db.exec('CREATE TABLE half_done (id INTEGER PRIMARY KEY)')
      throw new Error('boom')
    },
  }
}

function tableNames(db: Database.Database): unknown[] {
  return db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").pluck().all()
}

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
})

afterEach(() => {
  db.close()
})

describe('MIGRATIONS', () => {
  it('starts with the schema version table', () => {
    expect(MIGRATIONS[0]).toBe(schemaVersionMigration)
  })
})

describe('schemaVersion', () => {
  it('is 0 for a fresh database', () => {
    expect(schemaVersion(db)).toBe(0)
  })

  it('is 0 when the version table exists but is empty', () => {
    schemaVersionMigration.up(db)
    expect(schemaVersion(db)).toBe(0)
  })
})

describe('migrate', () => {
  it('runs every migration on a fresh database and records each one', () => {
    const result = migrate(db, [schemaVersionMigration, createTable(2, 'alpha'), createTable(3, 'beta')])

    expect(result).toEqual({ fromVersion: 0, toVersion: 3, applied: [1, 2, 3] })
    expect(schemaVersion(db)).toBe(3)
    expect(tableNames(db)).toEqual(['alpha', 'beta', 'schema_version'])
    const rows = db.prepare('SELECT version, name, applied_at FROM schema_version ORDER BY version').all()
    expect(rows).toEqual([
      { version: 1, name: 'Create the schema version table', applied_at: expect.any(String) as unknown },
      { version: 2, name: 'Create alpha', applied_at: expect.any(String) as unknown },
      { version: 3, name: 'Create beta', applied_at: expect.any(String) as unknown },
    ])
  })

  it('is a no-op when run again', () => {
    const migrations = [schemaVersionMigration, createTable(2, 'alpha')]
    migrate(db, migrations)

    expect(migrate(db, migrations)).toEqual({ fromVersion: 2, toVersion: 2, applied: [] })
    expect(db.prepare('SELECT COUNT(*) FROM schema_version').pluck().get()).toBe(2)
  })

  it('runs only the migrations added since the last run', () => {
    migrate(db, [schemaVersionMigration])

    const result = migrate(db, [schemaVersionMigration, createTable(2, 'alpha')])

    expect(result).toEqual({ fromVersion: 1, toVersion: 2, applied: [2] })
  })

  it('rolls back a failing migration and leaves the version unchanged', () => {
    migrate(db, [schemaVersionMigration])

    expect(() => migrate(db, [schemaVersionMigration, createTable(2, 'alpha'), failing(3)])).toThrow(
      expect.objectContaining({ message: 'Migration 3 (Fail halfway) failed', cause: new Error('boom') }) as Error,
    )

    // Migration 2 committed on its own; migration 3's partial work is gone.
    expect(schemaVersion(db)).toBe(2)
    expect(tableNames(db)).toEqual(['alpha', 'schema_version'])
    expect(db.inTransaction).toBe(false)
  })

  it('retries a failed migration on the next run', () => {
    expect(() => migrate(db, [schemaVersionMigration, failing(2)])).toThrow('Migration 2 (Fail halfway) failed')

    expect(migrate(db, [schemaVersionMigration, createTable(2, 'alpha')]).applied).toEqual([2])
  })

  it('refuses migrations that are not numbered 1, 2, 3, … in order', () => {
    expect(() => migrate(db, [schemaVersionMigration, createTable(3, 'alpha')])).toThrow(
      'Migrations must be numbered 1, 2, 3, … in order: position 2 has version 3',
    )
    expect(() => migrate(db, [createTable(2, 'alpha'), schemaVersionMigration])).toThrow('position 1 has version 2')
    expect(schemaVersion(db)).toBe(0)
  })

  it('refuses a database newer than the app', () => {
    migrate(db, [schemaVersionMigration, createTable(2, 'alpha')])

    expect(() => migrate(db, [schemaVersionMigration])).toThrow(
      'The database is at schema version 2, newer than this app knows (1)',
    )
  })
})
