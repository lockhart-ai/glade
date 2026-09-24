// Each library script, played through the real agent runner into a database: what the chat, tool log and task end up
// with is what an e2e spec or a capture sees.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MessageRole,
  TaskActivity,
  ToolCallState,
  ToolEventKind,
  type Task,
  type ToolCallEvent,
} from '../../shared/domain'
import { listMessages } from '../db/repositories/messages'
import { listQueuedMessages } from '../db/repositories/queued-messages'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { listToolEvents } from '../db/repositories/tool-events'
import { createAgentRunner, STOPPED_NOTE, type AgentRunner } from './runner'
import { createGladeMcpServer, GLADE_SERVER } from './glade-tools'
import { AGENT_SCRIPT_NAMES, AGENT_SCRIPTS, type AgentScriptName } from './scripts'
import { createTestModeAgentBackend, type TestModeAgentBackend } from './test-mode-backend'

let database: TestDatabase
let task: Task
let runner: AgentRunner | undefined
let backend: TestModeAgentBackend

function start(name: AgentScriptName): AgentRunner {
  backend = createTestModeAgentBackend({ script: AGENT_SCRIPTS[name] })
  const context = { db: database.db, emit: () => undefined }
  runner = createAgentRunner({
    ...context,
    backend,
    // The real Glade tools, as the app gives every session.
    mcpServers: (forTask) => ({ [GLADE_SERVER]: createGladeMcpServer(context, forTask.id) }),
  })
  return runner
}

/** Sends a message and lets the script play it out, however long its delays are. */
async function send(on: AgentRunner, text: string): Promise<void> {
  on.send(task.id, text)
  const idle = backend.whenIdle()
  await vi.runAllTimersAsync()
  await idle
}

function reply(): string | undefined {
  return listMessages(database.db, task.id).find((message) => message.role === MessageRole.Agent)?.body
}

function calls(): ToolCallEvent[] {
  return listToolEvents(database.db, task.id).filter((event) => event.kind === ToolEventKind.ToolCall)
}

function activity(): TaskActivity | undefined {
  return getTask(database.db, task.id)?.activity
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  database = openTestDatabase()
  task = sampleTask(database.db, sampleWorkspace(database.db).id)
})

afterEach(() => {
  runner?.close()
  runner = undefined
  database.close()
  vi.useRealTimers()
})

describe('AGENT_SCRIPTS', () => {
  it('names each script by its key', () => {
    expect(Object.keys(AGENT_SCRIPTS)).toEqual(AGENT_SCRIPT_NAMES)
    for (const name of AGENT_SCRIPT_NAMES) expect(AGENT_SCRIPTS[name].name).toBe(name)
  })

  it('simple-reply: sets the title, objective and status, then replies', async () => {
    const agent = start('simple-reply')
    await send(agent, 'How does the client retry?')

    expect(getTask(database.db, task.id)).toMatchObject({
      title: 'Explain the retry policy',
      objective: 'Explain how the API client retries failed requests.',
      status: 'Answered the question about retries.',
    })
    expect(reply()).toMatch(/^The client retries idempotent requests/)
    expect(calls().map((call) => [call.name, call.state])).toEqual([
      ['mcp__glade__set_title', ToolCallState.Done],
      ['mcp__glade__set_objective', ToolCallState.Done],
      ['mcp__glade__set_status', ToolCallState.Done],
    ])
    expect(activity()).toBe(TaskActivity.Waiting)
    expect(getTask(database.db, task.id)?.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('multi-tool-turn: narrates, works through file, search, subagent, edit and shell tools, then replies', async () => {
    const agent = start('multi-tool-turn')
    await send(agent, 'The date test is flaky.')

    const events = listToolEvents(database.db, task.id)
    expect(events.find((event) => event.kind === ToolEventKind.Narration)).toMatchObject({
      text: "I'll find where the date is formatted, then fix the timezone bug and run the tests.",
    })
    const subagent = calls().find((call) => call.name === 'Agent')
    expect(calls().map((call) => call.name)).toEqual([
      'mcp__glade__set_title',
      'mcp__glade__set_objective',
      'mcp__glade__set_status',
      'Read',
      'Grep',
      'Agent',
      'Grep',
      'Read',
      'Edit',
      'mcp__glade__set_status',
      'Bash',
      'mcp__glade__set_status',
    ])
    expect(
      calls()
        .filter((call) => call.parentToolUseId === subagent?.toolUseId)
        .map((call) => call.name),
    ).toEqual(['Grep', 'Read'])
    expect(calls().every((call) => call.state === ToolCallState.Done)).toBe(true)
    expect(reply()).toMatch(/^The failing test was a timezone bug/)
    expect(activity()).toBe(TaskActivity.Waiting)
    expect(getTask(database.db, task.id)).toMatchObject({
      title: 'Fix the flaky date test',
      objective: 'Make the date formatting test pass in every timezone.',
      status: 'Fixed the timezone bug; the tests pass.',
    })

    await send(agent, 'Check the report header too.')
    expect(listMessages(database.db, task.id).at(-1)?.body).toMatch(/^The report header already goes through/)
    expect(
      calls()
        .slice(-3)
        .map((call) => call.name),
    ).toEqual(['mcp__glade__set_status', 'Read', 'mcp__glade__set_status'])
    expect(getTask(database.db, task.id)?.status).toBe('The report header uses the UTC date too.')
  })

  it('long-running: keeps working, with its command running, until stopped', async () => {
    const agent = start('long-running')
    await send(agent, 'Run the e2e suite.')

    expect(activity()).toBe(TaskActivity.Working)
    expect(calls().at(-1)).toMatchObject({ name: 'Bash', state: ToolCallState.Running })
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(activity()).toBe(TaskActivity.Working)

    const stopped = agent.stop(task.id)
    await vi.runAllTimersAsync()
    await expect(stopped).resolves.toMatchObject({ activity: TaskActivity.Waiting })
    expect(calls().at(-1)).toMatchObject({ name: 'Bash', state: ToolCallState.Error, output: STOPPED_NOTE })
    expect(listToolEvents(database.db, task.id).at(-1)).toMatchObject({
      kind: ToolEventKind.Narration,
      text: STOPPED_NOTE,
    })
    expect(reply()).toBeUndefined()

    await send(agent, 'Only run the unit tests.')
    expect(reply()).toBe('Understood. I stopped the suite and will only run the unit tests.')
    expect(activity()).toBe(TaskActivity.Waiting)
  })

  it('long-running: runs the suite again and finishes the turn when resumed after the app quit', async () => {
    await send(start('long-running'), 'Run the e2e suite.')
    runner?.close()

    const resumed = start('long-running')
    resumed.resumeInterrupted()
    const idle = backend.whenIdle()
    await vi.runAllTimersAsync()
    await idle

    expect(reply()).toBe('The end-to-end suite passes: all 41 tests.')
    expect(calls().map(({ name, state }) => [name, state])).toEqual([
      ['mcp__glade__set_title', ToolCallState.Done],
      ['mcp__glade__set_objective', ToolCallState.Done],
      ['mcp__glade__set_status', ToolCallState.Done],
      ['Bash', ToolCallState.Error],
      ['Bash', ToolCallState.Done],
      ['mcp__glade__set_status', ToolCallState.Done],
    ])
    expect(getTask(database.db, task.id)).toMatchObject({
      activity: TaskActivity.Waiting,
      status: 'The e2e suite passes.',
    })
  })

  it('copy-in-batches: keeps a message queued while it copies, and answers it in the turn it resumes after a quit', async () => {
    const agent = start('copy-in-batches')
    await send(agent, 'Move image uploads to S3.')
    agent.queue(task.id, 'Keep the original filenames in the bucket keys.')
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(activity()).toBe(TaskActivity.Working)
    expect(listQueuedMessages(database.db, task.id).map(({ body }) => body)).toEqual([
      'Keep the original filenames in the bucket keys.',
    ])
    runner?.close()

    const resumed = start('copy-in-batches')
    resumed.resumeInterrupted()
    const idle = backend.whenIdle()
    await vi.runAllTimersAsync()
    await idle

    expect(listQueuedMessages(database.db, task.id)).toEqual([])
    expect(listMessages(database.db, task.id).map(({ role, body, turn }) => [role, body, turn])).toEqual([
      [MessageRole.User, 'Move image uploads to S3.', 1],
      [MessageRole.User, 'Keep the original filenames in the bucket keys.', 1],
      [MessageRole.Agent, 'All 3,900 files are in the bucket, and their keys keep the original filenames.', 1],
    ])
    expect(calls().map(({ name, state }) => [name, state])).toEqual([
      ['mcp__glade__set_title', ToolCallState.Done],
      ['mcp__glade__set_objective', ToolCallState.Done],
      ['mcp__glade__set_status', ToolCallState.Done],
      ['Bash', ToolCallState.Error],
      ['Bash', ToolCallState.Done],
      ['Bash', ToolCallState.Done],
      ['mcp__glade__set_status', ToolCallState.Done],
    ])
    expect(getTask(database.db, task.id)).toMatchObject({
      activity: TaskActivity.Waiting,
      status: 'All 3,900 files copied to S3, keeping their original filenames.',
    })
  })

  it('failing-turn: fails on an API error after its first tool call', async () => {
    const agent = start('failing-turn')
    await send(agent, 'Build it.')

    expect(calls().map((call) => [call.name, call.state])).toEqual([['Bash', ToolCallState.Done]])
    expect(listToolEvents(database.db, task.id).at(-1)).toMatchObject({
      kind: ToolEventKind.Narration,
      text: 'API Error: 529 Overloaded. Try again in a moment.',
    })
    expect(activity()).toBe(TaskActivity.Error)
    expect(reply()).toBeUndefined()
  })
})
