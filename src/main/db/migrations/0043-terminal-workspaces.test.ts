import { describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { listTerminalTabs } from '../repositories/terminal-tabs'
import { MIGRATIONS } from '.'
import { isInFolder, terminalWorkspacesMigration, workspaceHolding } from './0043-terminal-workspaces'

/** A database at the version before this migration. */
function before(): Database {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 43),
  )
  return db
}

function addWorkspace(db: Database, id: string, rootPath: string, createdAt: number): void {
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)').run(id, id, rootPath, createdAt, createdAt)
}

function addTab(db: Database, id: string, cwd: string, position: number): void {
  db.prepare('INSERT INTO terminal_tabs (id, name, cwd, position, created_at) VALUES (?, NULL, ?, ?, 1)').run(
    id,
    cwd,
    position,
  )
}

function setUiState(db: Database, key: string, value: string): void {
  db.prepare('INSERT INTO ui_state (key, value) VALUES (?, ?)').run(key, value)
}

function uiState(db: Database, key: string): unknown {
  return db.prepare('SELECT value FROM ui_state WHERE key = ?').pluck().get(key)
}

/** Each tab's workspace after the migration, by tab id. */
function workspaces(db: Database): Record<string, string | null> {
  return Object.fromEntries(listTerminalTabs(db).map(({ id, workspaceId }) => [id, workspaceId]))
}

it('is migration 43, after every earlier one', () => {
  expect(terminalWorkspacesMigration.version).toBe(43)
  expect(MIGRATIONS.indexOf(terminalWorkspacesMigration)).toBe(MIGRATIONS.filter((m) => m.version < 43).length)
})

describe('assigning the existing tabs', () => {
  it('gives a tab the workspace whose root holds its folder, the deepest when roots nest', () => {
    const db = before()
    addWorkspace(db, 'api', '/code/acme-api', 1)
    addWorkspace(db, 'web', '/code/acme-web', 2)
    addWorkspace(db, 'docs', '/code/acme-api/docs', 3)
    addTab(db, 'root', '/code/acme-api', 0)
    addTab(db, 'inside', '/code/acme-web/src/app', 1)
    addTab(db, 'nested', '/code/acme-api/docs/guide', 2)
    addTab(db, 'nested-root', '/code/acme-api/docs', 3)
    addTab(db, 'sibling', '/code/acme-api-v2', 4)

    migrate(db, MIGRATIONS)

    expect(workspaces(db)).toEqual({
      root: 'api',
      inside: 'web',
      nested: 'docs',
      'nested-root': 'docs',
      // Its folder only starts with the same letters as acme-api's: it's in no workspace, so it goes to the first.
      sibling: 'api',
    })
    expect(listTerminalTabs(db).map(({ id }) => id)).toEqual(['root', 'inside', 'nested', 'nested-root', 'sibling'])
    db.close()
  })

  it('gives a tab in no workspace’s folder the workspace that was showing', () => {
    const db = before()
    addWorkspace(db, 'api', '/code/acme-api', 1)
    addWorkspace(db, 'web', '/code/acme-web', 2)
    setUiState(db, 'active_workspace_id', 'web')
    addTab(db, 'home', '/Users/sample', 0)
    addTab(db, 'api', '/code/acme-api/src', 1)

    migrate(db, MIGRATIONS)

    expect(workspaces(db)).toEqual({ home: 'web', api: 'api' })
    db.close()
  })

  it('gives it the first workspace when none was showing, or the one showing is gone', () => {
    for (const shown of [undefined, '', 'gone']) {
      const db = before()
      addWorkspace(db, 'web', '/code/acme-web', 2)
      addWorkspace(db, 'api', '/code/acme-api', 1)
      if (shown !== undefined) setUiState(db, 'active_workspace_id', shown)
      addTab(db, 'home', '/Users/sample', 0)

      migrate(db, MIGRATIONS)

      expect(workspaces(db)).toEqual({ home: 'api' })
      db.close()
    }
  })

  it('leaves a tab with no workspace when there’s none, for the window with none open', () => {
    const db = before()
    addTab(db, 'home', '/Users/sample', 0)

    migrate(db, MIGRATIONS)

    expect(workspaces(db)).toEqual({ home: null })
    db.close()
  })

  it('does nothing with no tabs, and later tabs go with their workspace', () => {
    const db = before()
    addWorkspace(db, 'api', '/code/acme-api', 1)

    migrate(db, MIGRATIONS)

    expect(listTerminalTabs(db)).toEqual([])
    db.prepare(
      "INSERT INTO terminal_tabs (id, workspace_id, name, cwd, position, created_at) VALUES ('t', 'api', NULL, '/code/acme-api', 0, 1)",
    ).run()
    db.prepare("DELETE FROM workspaces WHERE id = 'api'").run()
    expect(listTerminalTabs(db)).toEqual([])
    db.close()
  })
})

describe('the tab the bottom bar showed', () => {
  it('becomes its workspace’s pick, and the old key goes', () => {
    const db = before()
    addWorkspace(db, 'api', '/code/acme-api', 1)
    addWorkspace(db, 'web', '/code/acme-web', 2)
    addTab(db, 'a', '/code/acme-api', 0)
    addTab(db, 'w', '/code/acme-web', 1)
    setUiState(db, 'terminal_tab', 'w')

    migrate(db, MIGRATIONS)

    expect(uiState(db, 'terminal_tab')).toBeUndefined()
    expect(JSON.parse(String(uiState(db, 'terminal_selection')))).toEqual({ web: 'w' })
    db.close()
  })

  it('is the pick of the window with no workspace when its tab has none', () => {
    const db = before()
    addTab(db, 'home', '/Users/sample', 0)
    setUiState(db, 'terminal_tab', 'home')

    migrate(db, MIGRATIONS)

    expect(JSON.parse(String(uiState(db, 'terminal_selection')))).toEqual({ '': 'home' })
    db.close()
  })

  it('is forgotten when it named a tab that’s gone, or none was picked', () => {
    for (const picked of [undefined, 'gone']) {
      const db = before()
      addWorkspace(db, 'api', '/code/acme-api', 1)
      addTab(db, 'a', '/code/acme-api', 0)
      if (picked !== undefined) setUiState(db, 'terminal_tab', picked)

      migrate(db, MIGRATIONS)

      expect(uiState(db, 'terminal_tab')).toBeUndefined()
      expect(uiState(db, 'terminal_selection')).toBeUndefined()
      db.close()
    }
  })
})

describe('isInFolder', () => {
  it('holds the folder itself and what’s inside it, and nothing that only starts the same', () => {
    expect(isInFolder('/code/acme-api', '/code/acme-api')).toBe(true)
    expect(isInFolder('/code/acme-api/src', '/code/acme-api')).toBe(true)
    expect(isInFolder('/code/acme-api-v2', '/code/acme-api')).toBe(false)
    expect(isInFolder('/code', '/code/acme-api')).toBe(false)
  })

  it('takes a root with a trailing slash, as the file system’s root has', () => {
    expect(isInFolder('/code/acme-api', '/')).toBe(true)
    expect(isInFolder('/code/acme-api/src', '/code/acme-api/')).toBe(true)
  })
})

describe('workspaceHolding', () => {
  it('is undefined with no workspaces, or none holding the folder', () => {
    expect(workspaceHolding([], '/code/acme-api')).toBeUndefined()
    expect(workspaceHolding([{ id: 'web', rootPath: '/code/acme-web' }], '/code/acme-api')).toBeUndefined()
  })

  it('picks the deepest root, whatever order they come in', () => {
    const inner = { id: 'docs', rootPath: '/code/acme-api/docs' }
    const outer = { id: 'api', rootPath: '/code/acme-api' }
    expect(workspaceHolding([inner, outer], '/code/acme-api/docs/guide')).toBe(inner)
    expect(workspaceHolding([outer, inner], '/code/acme-api/docs/guide')).toBe(inner)
  })
})
