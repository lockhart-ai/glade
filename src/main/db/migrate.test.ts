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

  it('refuses migrations that do not start at 1 and go up', () => {
    expect(() => migrate(db, [schemaVersionMigration, createTable(3, 'alpha'), createTable(3, 'beta')])).toThrow(
      'Migrations must start at 1 and go up: position 3 has version 3',
    )
    expect(() => migrate(db, [schemaVersionMigration, createTable(3, 'alpha'), createTable(2, 'beta')])).toThrow(
      'position 3 has version 2',
    )
    expect(() => migrate(db, [createTable(2, 'alpha'), schemaVersionMigration])).toThrow('position 1 has version 2')
    expect(schemaVersion(db)).toBe(0)
  })

  it('skips a version reserved by work that has not landed yet', () => {
    const result = migrate(db, [schemaVersionMigration, createTable(2, 'alpha'), createTable(4, 'gamma')])

    expect(result).toEqual({ fromVersion: 0, toVersion: 4, applied: [1, 2, 4] })
    expect(tableNames(db)).toEqual(['alpha', 'gamma', 'schema_version'])
  })

  it('runs a skipped version once it lands, below the database version', () => {
    migrate(db, [schemaVersionMigration, createTable(2, 'alpha'), createTable(4, 'gamma')])

    const all = [schemaVersionMigration, createTable(2, 'alpha'), createTable(3, 'beta'), createTable(4, 'gamma')]
    expect(migrate(db, all)).toEqual({ fromVersion: 4, toVersion: 4, applied: [3] })
    expect(tableNames(db)).toEqual(['alpha', 'beta', 'gamma', 'schema_version'])
    expect(migrate(db, all).applied).toEqual([])
  })

  it('does nothing with no migrations on a fresh database', () => {
    expect(migrate(db, [])).toEqual({ fromVersion: 0, toVersion: 0, applied: [] })
  })

  describe('a migration that rebuilds a referenced table', () => {
    const parentAndChild: Migration = {
      version: 2,
      name: 'Create parent and child',
      up(on) {
        on.exec(`
          CREATE TABLE parent (id INTEGER PRIMARY KEY);
          CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent (id) ON DELETE CASCADE);
          INSERT INTO parent VALUES (1);
          INSERT INTO child VALUES (10, 1);
        `)
      },
    }
    const rebuild = (orphan: boolean): Migration => ({
      version: 3,
      name: 'Rebuild parent',
      rebuildsReferencedTable: true,
      up(on) {
        on.exec(`
          CREATE TABLE parent_new (id INTEGER PRIMARY KEY, note TEXT);
          INSERT INTO parent_new (id) SELECT id FROM parent ${orphan ? 'WHERE id != 1' : ''};
          DROP TABLE parent;
          ALTER TABLE parent_new RENAME TO parent;
        `)
      },
    })

    it('runs with foreign keys off, so dropping the old table keeps the rows that reference it', () => {
      db.pragma('foreign_keys = ON')

      migrate(db, [schemaVersionMigration, parentAndChild, rebuild(false)])

      expect(db.prepare('SELECT id FROM child').pluck().all()).toEqual([10])
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    })

    it('rolls back when a reference no longer holds, and puts foreign keys back as they were', () => {
      db.pragma('foreign_keys = OFF')

      expect(() => migrate(db, [schemaVersionMigration, parentAndChild, rebuild(true)])).toThrow(
        expect.objectContaining({ cause: new Error('1 rows break a foreign key') }) as Error,
      )

      expect(schemaVersion(db)).toBe(2)
      expect(db.prepare('SELECT id FROM parent').pluck().all()).toEqual([1])
      expect(db.pragma('foreign_keys', { simple: true })).toBe(0)
    })
  })

  it('refuses a database newer than the app', () => {
    migrate(db, [schemaVersionMigration, createTable(2, 'alpha')])

    expect(() => migrate(db, [schemaVersionMigration])).toThrow(
      'The database is at schema version 2, newer than this app knows (1)',
    )
  })
})
