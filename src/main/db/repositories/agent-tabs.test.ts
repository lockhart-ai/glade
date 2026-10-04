import { afterEach, beforeEach, expect, it } from 'vitest'
import { getAgentTab, setAgentTab } from './agent-tabs'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'

let database: TestDatabase
let taskId: string
let otherId: string

beforeEach(() => {
  database = openTestDatabase()
  const workspaceId = sampleWorkspace(database.db).id
  taskId = sampleTask(database.db, workspaceId).id
  otherId = sampleTask(database.db, workspaceId).id
})

afterEach(() => {
  database.close()
})

it('has every task on Main until a subagent’s tab is picked', () => {
  expect(getAgentTab(database.db, taskId)).toBeNull()
  expect(getAgentTab(database.db, 'gone')).toBeNull()
})

it('remembers each task’s own agent, the last one picked, and forgets it on Main', () => {
  const { db } = database
  setAgentTab(db, taskId, 'toolu_fix_501')
  setAgentTab(db, otherId, 'toolu_docs_503')
  expect(getAgentTab(db, taskId)).toBe('toolu_fix_501')
  expect(getAgentTab(db, otherId)).toBe('toolu_docs_503')

  setAgentTab(db, taskId, 'toolu_limits_502')
  expect(getAgentTab(db, taskId)).toBe('toolu_limits_502')

  setAgentTab(db, taskId, null)
  expect(getAgentTab(db, taskId)).toBeNull()
  expect(db.prepare('SELECT COUNT(*) FROM agent_tabs').pluck().get()).toBe(1)
  // Main again, with nothing to forget.
  setAgentTab(db, taskId, null)
  expect(getAgentTab(db, otherId)).toBe('toolu_docs_503')
})
