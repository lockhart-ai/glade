import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  addTerminalTab,
  listTerminalTabs,
  removeTerminalTab,
  renameTerminalTab,
  saveTerminalScrollback,
} from './terminal-tabs'
import { openTestDatabase, type TestDatabase } from './test-database'

let database: TestDatabase

beforeEach(() => {
  database = openTestDatabase()
})

afterEach(() => {
  database.close()
})

function ids(): string[] {
  return listTerminalTabs(database.db).map(({ id }) => id)
}

it('starts with no tabs', () => {
  expect(listTerminalTabs(database.db)).toEqual([])
})

it('adds tabs at the end, or after another', () => {
  const { db } = database
  addTerminalTab(db, { id: 'a', name: null, cwd: '/code/api', after: null })
  addTerminalTab(db, { id: 'b', name: null, cwd: '/code/api', after: null })
  addTerminalTab(db, { id: 'c', name: 'server', cwd: '/code/web', after: 'a' })
  addTerminalTab(db, { id: 'd', name: null, cwd: '/code/web', after: 'gone' })

  expect(ids()).toEqual(['a', 'c', 'b', 'd'])
  expect(listTerminalTabs(db)[1]).toEqual({ id: 'c', name: 'server', cwd: '/code/web', scrollback: '' })
})

it('renames a tab, keeps its output, and removes it', () => {
  const { db } = database
  addTerminalTab(db, { id: 'a', name: null, cwd: '/code/api', after: null })
  addTerminalTab(db, { id: 'b', name: null, cwd: '/code/api', after: null })

  renameTerminalTab(db, 'a', 'server')
  saveTerminalScrollback(db, 'a', '$ npm start\r\nListening on 8000\r\n')
  expect(listTerminalTabs(db)[0]).toEqual({
    id: 'a',
    name: 'server',
    cwd: '/code/api',
    scrollback: '$ npm start\r\nListening on 8000\r\n',
  })
  renameTerminalTab(db, 'a', null)
  expect(listTerminalTabs(db)[0]?.name).toBeNull()

  removeTerminalTab(db, 'a')
  expect(ids()).toEqual(['b'])
})
