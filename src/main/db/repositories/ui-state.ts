import type { Database } from 'better-sqlite3'
import type { UiStateEntry, UiStateKey } from '../../../shared/domain'
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
