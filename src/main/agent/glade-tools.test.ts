import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventType, type GladeEvent } from '../../shared/bridge'
import type { Task } from '../../shared/domain'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import type { TaskServiceContext } from '../tasks/service'
import { createGladeMcpServer, createGladeToolHandlers, GLADE_SERVER, GladeTool } from './glade-tools'
import { createMcpToolCaller, type McpToolCaller } from './mcp-tool-caller'

let database: TestDatabase
let task: Task
let events: GladeEvent[]
let context: TaskServiceContext
let caller: McpToolCaller

beforeEach(() => {
  database = openTestDatabase()
  task = sampleTask(database.db, sampleWorkspace(database.db).id)
  events = []
  context = { db: database.db, emit: (event) => events.push(event) }
  caller = createMcpToolCaller({ [GLADE_SERVER]: createGladeMcpServer(context, task.id) })
})

afterEach(async () => {
  await caller.close()
  database.close()
})

function current(): Task {
  const found = getTask(database.db, task.id)
  if (found === undefined) throw new Error('The task is gone')
  return found
}

/** The `task.updated` events since the last call, as the fields the tools set. */
function drainUpdates(): unknown[] {
  return events.splice(0).map((event) => {
    if (event.type !== EventType.TaskUpdated) return event.type
    const { title, objective, status } = event.task
    return { title, objective, status }
  })
}

describe('the handlers', () => {
  it('set the title, objective and status, tell the windows, and confirm to the model', () => {
    const handlers = createGladeToolHandlers(context, task.id)

    expect(handlers.setTitle({ title: 'Fix the flaky login test' })).toEqual({
      content: [{ type: 'text', text: 'Title set to "Fix the flaky login test".' }],
    })
    expect(handlers.setObjective({ objective: 'Make the login test pass every run.' })).toEqual({
      content: [{ type: 'text', text: 'Objective set.' }],
    })
    expect(handlers.setStatus({ status: 'Reproducing the flake.' })).toEqual({
      content: [{ type: 'text', text: 'Status updated.' }],
    })

    expect(current()).toMatchObject({
      title: 'Fix the flaky login test',
      objective: 'Make the login test pass every run.',
      status: 'Reproducing the flake.',
    })
    expect(drainUpdates()).toEqual([
      { title: 'Fix the flaky login test', objective: '', status: '' },
      { title: 'Fix the flaky login test', objective: 'Make the login test pass every run.', status: '' },
      {
        title: 'Fix the flaky login test',
        objective: 'Make the login test pass every run.',
        status: 'Reproducing the flake.',
      },
    ])
  })

  it('replace the objective on a second set_objective, and say so', () => {
    const handlers = createGladeToolHandlers(context, task.id)
    handlers.setObjective({ objective: 'Make the login test pass every run.' })

    expect(handlers.setObjective({ objective: 'Delete the login test.' })).toEqual({
      content: [{ type: 'text', text: 'Objective replaced.' }],
    })
    expect(current().objective).toBe('Delete the login test.')
  })
})

describe('the server', () => {
  it('is named glade and loads every tool up front, so none hides behind tool search', async () => {
    const server = createGladeMcpServer(context, task.id)
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.instance.connect(serverSide)
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(clientSide)

    const { tools } = await client.listTools()

    expect(server).toMatchObject({ type: 'sdk', name: GLADE_SERVER })
    expect(tools.map((listed) => listed.name)).toEqual([
      GladeTool.SetTitle,
      GladeTool.SetObjective,
      GladeTool.SetStatus,
    ])
    for (const listed of tools) expect(listed._meta).toEqual({ 'anthropic/alwaysLoad': true })
    expect(tools.map((listed) => listed.inputSchema.required)).toEqual([['title'], ['objective'], ['status']])
    await client.close()
  })

  it('runs the handlers for valid calls, trimming what the model sends', async () => {
    await expect(caller.call('mcp__glade__set_title', { title: '  Fix the flaky login test\n' })).resolves.toEqual({
      output: 'Title set to "Fix the flaky login test".',
      isError: false,
    })
    await expect(caller.call('mcp__glade__set_objective', { objective: 'Make it pass.' })).resolves.toEqual({
      output: 'Objective set.',
      isError: false,
    })
    await expect(caller.call('mcp__glade__set_status', { status: 'Reproducing.' })).resolves.toEqual({
      output: 'Status updated.',
      isError: false,
    })
    expect(current()).toMatchObject({
      title: 'Fix the flaky login test',
      objective: 'Make it pass.',
      status: 'Reproducing.',
    })
  })

  it('answers invalid input with a tool error and changes nothing', async () => {
    const calls: [string, Record<string, unknown>][] = [
      ['mcp__glade__set_title', {}],
      ['mcp__glade__set_title', { title: '   ' }],
      ['mcp__glade__set_objective', { objective: 42 }],
      ['mcp__glade__set_status', { state: 'Reproducing.' }],
      ['mcp__glade__set_status', { status: null }],
    ]
    for (const [name, input] of calls) {
      const outcome = await caller.call(name, input)
      expect(outcome.isError).toBe(true)
      expect(outcome.output).toContain('Input validation error')
    }
    const empty = await caller.call('mcp__glade__set_title', { title: '' })
    expect(empty.output).toContain('The title is empty.')

    expect(current()).toMatchObject({ title: '', objective: '', status: '' })
    expect(events).toEqual([])
  })

  it('answers with a tool error when the task is gone', async () => {
    const orphan = createMcpToolCaller({ [GLADE_SERVER]: createGladeMcpServer(context, 'gone') })

    const outcome = await orphan.call('mcp__glade__set_status', { status: 'Reproducing.' })

    expect(outcome).toEqual({ output: 'No task gone', isError: true })
    expect(events).toEqual([])
    await orphan.close()
  })
})
