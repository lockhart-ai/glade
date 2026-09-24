// The native-module ABI split between Node (Vitest) and Electron (the app) is handled by better-sqlite3 itself: since
// v13 it is a Node-API addon and ships prebuilt binaries in the package. Node-API is ABI-stable across Node and
// Electron, so the one installed binary loads under both, with no electron-rebuild step, postinstall hook or
// per-target build. `database.crash.test.ts` loads it under Electron's Node to keep that true.
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate, type MigrationResult, type Migration } from './migrate'
import { MIGRATIONS } from './migrations'

/** The database file's name inside the app's data folder. */
export const DATABASE_FILE_NAME = 'glade.db'

/**
 * Opens (creating if needed) the database at `file`, in WAL mode so a crash mid-write leaves it consistent, and with
 * foreign keys enforced.
 */
export function openDatabase(file: string): Database.Database {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  return db
}

/** An open, migrated app database. */
export interface AppDatabase {
  readonly db: Database.Database
  readonly file: string
  readonly migration: MigrationResult
}

/** Opens the app database in `dataDir` and migrates it to the latest schema. Closes it again if migrating fails. */
export function openAppDatabase(dataDir: string, migrations: readonly Migration[] = MIGRATIONS): AppDatabase {
  const file = join(dataDir, DATABASE_FILE_NAME)
  const db = openDatabase(file)
  try {
    return { db, file, migration: migrate(db, migrations) }
  } catch (error) {
    db.close()
    throw error
  }
}
