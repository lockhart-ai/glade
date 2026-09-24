// Each library script, played through the real agent runner into a database: what the chat, tool log and task end up
// with is what an e2e spec or a capture sees.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CompactionTrigger,
  AgentErrorKind,
  API_TOOL_NAME,
  MessageRole,
  TaskActivity,
  ToolCallState,
  ToolEventKind,
  type Task,
  type ToolCallEvent,
  type ToolEvent,
} from '../../shared/domain'
import { autoCompactThreshold } from '../../shared/contextWindow'
import { listMessages } from '../db/repositories/messages'
import { getOpenQuestionSet } from '../db/repositories/question-sets'
import { listQueuedMessages } from '../db/repositories/queued-messages'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { listToolEvents } from '../db/repositories/tool-events'
import { createQuestionBroker } from '../questions/questions'
import { createAgentRunner, STOPPED_NOTE, type AgentRunner } from './runner'
import { createGladeMcpServer, GLADE_SERVER } from './glade-tools'
import { AGENT_SCRIPT_NAMES, AGENT_SCRIPTS, RELEASE_NOTES_QUESTIONS, type AgentScriptName } from './scripts'
import { createTestModeAgentBackend, type TestModeAgentBackend } from './test-mode-backend'

let database: TestDatabase
let task: Task
let runner: AgentRunner | undefined
let backend: TestModeAgentBackend

function start(name: AgentScriptName): AgentRunner {
  backend = createTestModeAgentBackend({ script: AGENT_SCRIPTS[name] })
  const base = { db: database.db, emit: () => undefined }
  const questions = createQuestionBroker(base)
  const context = { ...base, questions }
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

/**
 * Sends a message and lets an hour pass, for a script that waits on the user: running every timer would also run out
 * the scripted agent's (practically endless) tool call timeout.
 */
async function sendAndWaitAnHour(on: AgentRunner, text: string): Promise<void> {
  on.send(task.id, text)
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
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

  it('auto-compaction: crosses the threshold, compacts on its own mid-turn, and carries on to its reply', async () => {
    const agent = start('auto-compaction')
    await send(agent, 'Move image uploads to S3.')

    // 97% of the window, past the SDK's auto-compact threshold, whatever the task's model.
    const windowTokens = getTask(database.db, task.id)?.contextWindowTokens ?? 0
    expect(0.97 * windowTokens).toBeGreaterThan(autoCompactThreshold(windowTokens))
    const log = listToolEvents(database.db, task.id)
    const compactionAt = log.findIndex((event) => event.kind === ToolEventKind.Compaction)
    expect(log[compactionAt]).toMatchObject({
      kind: ToolEventKind.Compaction,
      trigger: CompactionTrigger.Auto,
      state: ToolCallState.Done,
      preTokens: Math.round(0.97 * windowTokens),
      postTokens: 41_000,
      windowTokens,
      turn: 1,
    })
    // It happens between the sample check and updating the stored paths, and nothing before it is dropped.
    const names = (events: readonly ToolEvent[]): string[] =>
      events.flatMap((event) => (event.kind === ToolEventKind.ToolCall ? [event.name] : []))
    expect(names(log.slice(0, compactionAt))).toEqual([
      'mcp__glade__set_title',
      'mcp__glade__set_objective',
      'mcp__glade__set_status',
      'Bash',
      'Bash',
    ])
    expect(names(log.slice(compactionAt + 1))).toEqual(['mcp__glade__set_status', 'Bash'])
    expect(calls().every((call) => call.state === ToolCallState.Done)).toBe(true)
    expect(listMessages(database.db, task.id).map(({ role, turn }) => [role, turn])).toEqual([
      [MessageRole.User, 1],
      [MessageRole.Agent, 1],
    ])
    expect(reply()).toMatch(/^All 3,900 files are copied/)
    expect(getTask(database.db, task.id)).toMatchObject({ activity: TaskActivity.Waiting, contextUsedTokens: 41_000 })
  })

  it('failing-turn: fails on an API error after its first tool call, once its retries are spent', async () => {
    const agent = start('failing-turn')
    await send(agent, 'Build it.')

    expect(calls().map((call) => [call.name, call.state, call.input])).toEqual([
      ['Bash', ToolCallState.Done, expect.anything()],
      [API_TOOL_NAME, ToolCallState.Error, { request: 'request 4 of 4' }],
    ])
    expect(getTask(database.db, task.id)).toMatchObject({
      activity: TaskActivity.Error,
      retrying: null,
      error: { kind: AgentErrorKind.Transient, status: 529, code: 'overloaded', retries: 3 },
    })
    expect(reply()).toBeUndefined()
  })

  it('flaky-api: fails on an overloaded API, then gets through when retried', async () => {
    const agent = start('flaky-api')
    await send(agent, 'Fix the flaky login test.')
    expect(getTask(database.db, task.id)).toMatchObject({ activity: TaskActivity.Error, title: 'Fix flaky login test' })

    agent.retry(task.id)
    const idle = backend.whenIdle()
    await vi.runAllTimersAsync()
    await idle

    expect(reply()).toBe('The test passes 200 times in a row against Postgres, so the race is fixed.')
    expect(getTask(database.db, task.id)).toMatchObject({ activity: TaskActivity.Waiting, error: null, retrying: null })
    expect(listMessages(database.db, task.id).map((message) => message.turn)).toEqual([1, 1])
  })

  it('asks-a-question: asks its questions and waits, however long, then drafts the notes from the answers', async () => {
    const agent = start('asks-a-question')
    await sendAndWaitAnHour(agent, 'Draft the release notes for 2.4.')

    const open = getOpenQuestionSet(database.db, task.id)
    expect(open?.questions).toEqual(RELEASE_NOTES_QUESTIONS)
    expect(getTask(database.db, task.id)).toMatchObject({
      title: 'Draft release notes for 2.4',
      status: 'Waiting on three layout and credit questions.',
      activity: TaskActivity.Waiting,
      asking: true,
    })
    expect(reply()).toBeUndefined()

    agent.answer(open?.id ?? '', { 0: 'by-type', 1: 'Internal changes', 2: 'GitHub handles' })
    await vi.waitFor(() => {
      expect(activity()).toBe(TaskActivity.Waiting)
    })

    expect(reply()).toMatch(/^Thanks\. The release notes for 2\.4 are drafted/)
    expect(calls().find((call) => call.name === 'mcp__glade__ask')).toMatchObject({
      state: ToolCallState.Done,
      output: '{"0":"by-type","1":"Internal changes","2":"GitHub handles"}',
    })
    expect(getTask(database.db, task.id)?.status).toBe('Release notes drafted in docs/releases/2.4.md.')
  })

  it('asks-a-question: carries on from the answers when they come after the app quit', async () => {
    await sendAndWaitAnHour(start('asks-a-question'), 'Draft the release notes for 2.4.')
    runner?.close()
    const resumed = start('asks-a-question')
    resumed.resumeInterrupted()
    const open = getOpenQuestionSet(database.db, task.id)

    resumed.send(task.id, 'By type, internal changes, and GitHub handles.')
    const idle = backend.whenIdle()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    await idle

    expect(open).toBeDefined()
    expect(reply()).toMatch(/^Got your answers after the restart/)
    expect(listMessages(database.db, task.id).map(({ role, turn }) => [role, turn])).toEqual([
      [MessageRole.User, 1],
      [MessageRole.User, 1],
      [MessageRole.Agent, 1],
    ])
    expect(getTask(database.db, task.id)).toMatchObject({ activity: TaskActivity.Waiting, asking: false })
  })
})
