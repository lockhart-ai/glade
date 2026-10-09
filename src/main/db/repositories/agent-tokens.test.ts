import { beforeEach, expect, it } from 'vitest'
import { addAgentTokens, agentTokenTotals } from './agent-tokens'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'

let database: TestDatabase
let workspaceId: string
let taskId: string

beforeEach(() => {
  database = openTestDatabase()
  workspaceId = sampleWorkspace(database.db).id
  taskId = sampleTask(database.db, workspaceId).id
})

it('adds each agent’s messages into its total and gives the running total back', () => {
  expect(addAgentTokens(database.db, { taskId, agentId: null, inputTokens: 1000, outputTokens: 50 })).toEqual({
    agentId: null,
    inputTokens: 1000,
    outputTokens: 50,
  })
  expect(addAgentTokens(database.db, { taskId, agentId: null, inputTokens: 400, outputTokens: 10 })).toEqual({
    agentId: null,
    inputTokens: 1400,
    outputTokens: 60,
  })
  expect(addAgentTokens(database.db, { taskId, agentId: 'sub-1', inputTokens: 2000, outputTokens: 300 })).toEqual({
    agentId: 'sub-1',
    inputTokens: 2000,
    outputTokens: 300,
  })
  // Main's total is kept under an id of its own, so a subagent's never mixes into it.
  expect(agentTokenTotals(database.db, taskId)).toEqual([
    { agentId: null, inputTokens: 1400, outputTokens: 60 },
    { agentId: 'sub-1', inputTokens: 2000, outputTokens: 300 },
  ])
  // Zero tokens still add nothing.
  expect(addAgentTokens(database.db, { taskId, agentId: 'sub-1', inputTokens: 0, outputTokens: 0 })).toEqual({
    agentId: 'sub-1',
    inputTokens: 2000,
    outputTokens: 300,
  })
})

it('keeps each task’s totals to itself, and loses them when the task goes', () => {
  const other = sampleTask(database.db, workspaceId)
  addAgentTokens(database.db, { taskId, agentId: null, inputTokens: 100, outputTokens: 1 })
  addAgentTokens(database.db, { taskId: other.id, agentId: null, inputTokens: 700, outputTokens: 2 })
  expect(agentTokenTotals(database.db, other.id)).toEqual([{ agentId: null, inputTokens: 700, outputTokens: 2 }])
  expect(agentTokenTotals(database.db, 'missing-task')).toEqual([])

  database.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)
  expect(agentTokenTotals(database.db, taskId)).toEqual([])
})
