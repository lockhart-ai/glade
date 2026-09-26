import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DATABASE_FILE_NAME, openAppDatabase, openDatabase } from './database'
import { latestVersion, schemaVersion } from './migrate'
import { MIGRATIONS } from './migrations'

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'glade-db-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('openDatabase', () => {
  it('turns on WAL mode and foreign keys', () => {
    const db = openDatabase(join(dataDir, 'test.db'))
    try {
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    } finally {
      db.close()
    }
  })

  it('enforces foreign keys', () => {
    const db = openDatabase(join(dataDir, 'test.db'))
    try {
      db.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY)')
      db.exec('CREATE TABLE child (parent_id INTEGER NOT NULL REFERENCES parent (id))')
      expect(() => db.exec('INSERT INTO child (parent_id) VALUES (1)')).toThrow('FOREIGN KEY constraint failed')
    } finally {
      db.close()
    }
  })
})

describe('openAppDatabase', () => {
  it('creates glade.db in the data folder and migrates it to the latest version', () => {
    const { db, file, migration } = openAppDatabase(dataDir)
    try {
      expect(file).toBe(join(dataDir, DATABASE_FILE_NAME))
      expect(existsSync(file)).toBe(true)
      expect(migration).toEqual({
        fromVersion: 0,
        toVersion: latestVersion(MIGRATIONS),
        applied: MIGRATIONS.map((m) => m.version),
      })
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    } finally {
      db.close()
    }
  })

  it('does nothing more when the app starts again', () => {
    openAppDatabase(dataDir).db.close()

    const { db, migration } = openAppDatabase(dataDir)
    try {
      expect(migration).toEqual({
        fromVersion: latestVersion(MIGRATIONS),
        toVersion: latestVersion(MIGRATIONS),
        applied: [],
      })
    } finally {
      db.close()
    }
  })

  it('rethrows when a migration fails, leaving the version where it was', () => {
    const failing = {
      version: latestVersion(MIGRATIONS) + 1,
      name: 'Fail',
      up() {
        throw new Error('boom')
      },
    }
    expect(() => openAppDatabase(dataDir, [...MIGRATIONS, failing])).toThrow(
      `Migration ${String(latestVersion(MIGRATIONS) + 1)} (Fail) failed`,
    )

    const db = openDatabase(join(dataDir, DATABASE_FILE_NAME))
    try {
      expect(schemaVersion(db)).toBe(latestVersion(MIGRATIONS))
    } finally {
      db.close()
    }
  })
})
