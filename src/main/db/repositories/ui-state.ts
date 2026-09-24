import type { Database } from 'better-sqlite3'
import { UiStateKey, type UiStateEntry } from '../../../shared/domain'
import { Row } from './rows'

/** The stored value for `key`, or undefined when it has never been set. */
export function getUiState(db: Database, key: UiStateKey): string | undefined {
  const row: unknown = db.prepare('SELECT value FROM ui_state WHERE key = ?').get(key)
  return row === undefined ? undefined : new Row('ui_state', row).text('value')
}

/** Stores a value, replacing any earlier one for the same key. */
export function setUiState(db: Database, entry: UiStateEntry): void {
  db.prepare(
    'INSERT INTO ui_state (key, value) VALUES (@key, @value) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run(entry)
}

const UI_STATE_KEYS: readonly string[] = Object.values(UiStateKey)

function isUiStateKey(key: string): key is UiStateKey {
  return UI_STATE_KEYS.includes(key)
}

/**
 * Every stored value. Rows whose key isn't a `UiStateKey` (the table has no CHECK on keys, so a newer app version could
 * have left one) are skipped.
 */
export function listUiState(db: Database): UiStateEntry[] {
  return db
    .prepare('SELECT key, value FROM ui_state ORDER BY key')
    .all()
    .flatMap((raw): UiStateEntry[] => {
      const row = new Row('ui_state', raw)
      const key = row.text('key')
      return isUiStateKey(key) ? [{ key, value: row.text('value') }] : []
    })
}
