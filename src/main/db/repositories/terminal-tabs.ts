import type { Database } from 'better-sqlite3'
import type { EpochMs } from '../../../shared/domain'
import { Row } from './rows'

/** A terminal tab as it's stored: what survives a restart. */
export interface TerminalTabRow {
  readonly id: string
  /** The name you gave it, or null for the default. */
  readonly name: string | null
  /** The folder its shell starts in. */
  readonly cwd: string
  /** The recent output it showed, as the terminal received it (escape sequences and all). */
  readonly scrollback: string
}

/** A terminal tab to add. */
export interface NewTerminalTab {
  readonly id: string
  readonly name: string | null
  readonly cwd: string
  /** The tab it goes after in the tab row; at the end when null. */
  readonly after: string | null
}

const COLUMNS = 'id, name, cwd, scrollback'

function parseTerminalTab(raw: unknown): TerminalTabRow {
  const row = new Row('terminal_tabs', raw)
  return {
    id: row.text('id'),
    name: row.nullableText('name'),
    cwd: row.text('cwd'),
    scrollback: row.text('scrollback'),
  }
}

/** Every terminal tab, in the tab row's order. */
export function listTerminalTabs(db: Database): TerminalTabRow[] {
  return db.prepare(`SELECT ${COLUMNS} FROM terminal_tabs ORDER BY position, rowid`).all().map(parseTerminalTab)
}

/** Adds a terminal tab with no output, after the tab `after` names (or at the end, when it's null or gone). */
export function addTerminalTab(
  db: Database,
  { id, name, cwd, after }: NewTerminalTab,
  now: EpochMs = Date.now(),
): void {
  db.transaction(() => {
    const before =
      after === null
        ? undefined
        : (db.prepare('SELECT position FROM terminal_tabs WHERE id = ?').pluck().get(after) as number | undefined)
    let position: number
    if (before === undefined) {
      position = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) FROM terminal_tabs').pluck().get() as number
    } else {
      position = before + 1
      db.prepare('UPDATE terminal_tabs SET position = position + 1 WHERE position >= ?').run(position)
    }
    db.prepare('INSERT INTO terminal_tabs (id, name, cwd, position, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      name,
      cwd,
      position,
      now,
    )
  })()
}

/** Names a terminal tab, or gives it back its default name with null. */
export function renameTerminalTab(db: Database, id: string, name: string | null): void {
  db.prepare('UPDATE terminal_tabs SET name = ? WHERE id = ?').run(name, id)
}

/** Keeps a terminal tab's recent output. */
export function saveTerminalScrollback(db: Database, id: string, scrollback: string): void {
  db.prepare('UPDATE terminal_tabs SET scrollback = ? WHERE id = ?').run(scrollback, id)
}

/** Removes a terminal tab, and its output with it. */
export function removeTerminalTab(db: Database, id: string): void {
  db.prepare('DELETE FROM terminal_tabs WHERE id = ?').run(id)
}
