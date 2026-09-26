import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Each library script, played through the real agent runner into a database: what the chat, tool log and task end up
// with is what an e2e spec or a capture sees.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventType, type GladeEvent } from '../../shared/bridge'
import {
  CompactionTrigger,
  AgentErrorKind,
  DividerKind,
  API_TOOL_NAME,
  MessageRole,
  PauseReason,
  PermissionDecisionKind,
  PermissionMode,
  PermissionRequestState,
  TaskActivity,
  TodoState,
  ToolCallState,
  ToolEventKind,
  type PermissionDecision,
  type Task,
  type TaskPause,
  type ToolCallEvent,
  type ToolEvent,
} from '../../shared/domain'
import { autoCompactThreshold } from '../../shared/contextWindow'
import { listArtifacts } from '../db/repositories/artifacts'
import { listMessages } from '../db/repositories/messages'
import { getOpenQuestionSet } from '../db/repositories/question-sets'
import { listQueuedMessages } from '../db/repositories/queued-messages'
import { getOpenFiles } from '../db/repositories/open-files'
import { listOpenPermissionRequests, listPermissionRequests } from '../db/repositories/permission-requests'
import { getTask, updateTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { listToolEvents } from '../db/repositories/tool-events'
import type { NotifyReply } from '../notifications/notifications'
import { createQuestionBroker } from '../questions/questions'
import { todoListFor } from '../todos/todos'
import { createAgentRunner, STOPPED_NOTE, type AgentRunner } from './runner'
import { createGladeMcpServer, GLADE_SERVER } from './glade-tools'
import {
  AGENT_SCRIPT_NAMES,
  AGENT_SCRIPTS,
  ALLOWS_FOR_TASK,
  ASKS_PERMISSION,
  DELETE_LOCAL_COPIES_QUESTION,
  FOLLOW_UPS,
  PARALLEL_SUBAGENTS,
  PERMISSION_AT_QUIT,
  RELEASE_NOTES_QUESTIONS,
  S3_PLAN,
  SUBAGENT_CALLS_REPLY,
  type AgentScriptName,
} from './scripts'
import { OFFLINE_FIRST_CHECK_MS } from './pauses'
import { createTestModeAgentBackend, type TestModeAgentBackend } from './test-mode-backend'
import { createMemoryLog } from '../logging/memory-sink'
import type { Logger } from '../logging/logger'

let database: TestDatabase
let task: Task
let runner: AgentRunner | undefined
let backend: TestModeAgentBackend

/** What a test hears from the runner: the bridge events it broadcasts, and the replies it notifies. */
interface Listeners {
  readonly emit?: (event: GladeEvent) => void
  readonly notifyReply?: NotifyReply
  /** Where the runner reports what it drops or ignores; the console by default. */
  readonly log?: Logger
}

function start(name: AgentScriptName, { emit = () => undefined, notifyReply, log }: Listeners = {}): AgentRunner {
  backend = createTestModeAgentBackend({ script: AGENT_SCRIPTS[name] })
  const base = { db: database.db, emit }
  const questions = createQuestionBroker(base)
  const context = { ...base, questions }
  runner = createAgentRunner({
    ...context,
    backend,
    ...(notifyReply === undefined ? {} : { notifyReply }),
    ...(log === undefined ? {} : { log }),
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

  it.each(AGENT_SCRIPT_NAMES)('%s: streams only messages the runner can read, every turn of it', async (name) => {
    const memory = createMemoryLog()
    const agent = start(name, { log: memory.logger })
    for (const [index] of AGENT_SCRIPTS[name].turns.entries()) {
      // A turn still working (waiting to be stopped, say) is stopped first, so the next message starts a turn.
      if (activity() === TaskActivity.Working) {
        const stopped = agent.stop(task.id)
        await vi.advanceTimersByTimeAsync(0)
        await stopped
      }
      if (activity() === TaskActivity.Paused) break
      agent.send(task.id, `Message ${String(index + 1)}.`)
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    }
    // What the parser drops, it says so about: nothing a script plays should be dropped.
    const dropped = memory.records
      .map(({ message }) => message)
      .filter((message) => message.startsWith('Dropped') || message.startsWith('Ignored SDK'))
    expect(dropped).toEqual([])
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

  it('shows-a-file: reads and edits a doc, then shows it in the Files tab at the line to check', async () => {
    const root = mkdtempSync(join(tmpdir(), 'glade-shows-a-file-'))
    try {
      mkdirSync(join(root, 'docs'))
      writeFileSync(join(root, 'docs', 'rate-limits.md'), '# Rate limits\n')
      task = sampleTask(database.db, sampleWorkspace(database.db, root).id)
      // Real timers: \`show_file\` reads the disk, which fake timers would race with the tool call's timeout.
      vi.useRealTimers()
      const agent = start('shows-a-file')
      agent.send(task.id, 'Document the rate limits.')
      await backend.whenIdle()

      expect(calls().map((call) => [call.name, call.state])).toEqual([
        ['mcp__glade__set_title', ToolCallState.Done],
        ['mcp__glade__set_objective', ToolCallState.Done],
        ['mcp__glade__set_status', ToolCallState.Done],
        ['Read', ToolCallState.Done],
        ['Edit', ToolCallState.Done],
        ['mcp__glade__show_file', ToolCallState.Done],
        ['mcp__glade__set_status', ToolCallState.Done],
      ])
      expect(getOpenFiles(database.db, task.id)).toMatchObject({ activePath: 'docs/rate-limits.md' })
      expect(reply()).toMatch(/Line 8 has the tighter \/search limit/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('declares-artifacts: writes release notes and an upgrade guide, and declares both as artifacts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'glade-declares-artifacts-'))
    try {
      mkdirSync(join(root, 'docs', 'releases'), { recursive: true })
      writeFileSync(join(root, 'docs', 'releases', '2.4.md'), '# Release notes 2.4\n')
      writeFileSync(join(root, 'docs', 'releases', '2.4-upgrade.md'), '# Upgrading to 2.4\n')
      task = sampleTask(database.db, sampleWorkspace(database.db, root).id)
      // Real timers: \`add_artifact\` reads the disk, which fake timers would race with the tool call's timeout.
      vi.useRealTimers()
      const agent = start('declares-artifacts')
      agent.send(task.id, 'Draft the 2.4 release notes.')
      await backend.whenIdle()

      expect(calls().map((call) => [call.name, call.state])).toEqual([
        ['mcp__glade__set_title', ToolCallState.Done],
        ['mcp__glade__set_objective', ToolCallState.Done],
        ['mcp__glade__set_status', ToolCallState.Done],
        ['Write', ToolCallState.Done],
        ['Write', ToolCallState.Done],
        ['mcp__glade__add_artifact', ToolCallState.Done],
        ['mcp__glade__add_artifact', ToolCallState.Done],
        ['mcp__glade__set_status', ToolCallState.Done],
      ])
      expect(listArtifacts(database.db, task.id).map(({ path, title }) => [path, title])).toEqual([
        ['docs/releases/2.4.md', 'Release notes 2.4'],
        ['docs/releases/2.4-upgrade.md', 'Upgrade guide'],
      ])
      expect(reply()).toBe('The release notes and an upgrade guide are ready in Artifacts.')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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

  it('parallel-subagents: runs three subagents side by side, one finishing, until stopped', async () => {
    const agent = start('parallel-subagents')
    await send(agent, 'Draft the 2.4 release notes.')

    const agents = calls().filter((call) => call.name === 'Agent')
    // Each running one says what it's doing now; the link check's late summary changed nothing.
    expect(agents.map((call) => [call.input.description, call.state, call.progressSummary])).toEqual([
      ['API changes', ToolCallState.Running, PARALLEL_SUBAGENTS.apiSummary],
      ['Dashboard changes', ToolCallState.Running, PARALLEL_SUBAGENTS.dashboardSummary],
      ['Check links in the 2.3 notes', ToolCallState.Done, null],
    ])
    const [api, dashboard, links] = agents.map((call) => call.toolUseId)
    const nested = (parent: string | undefined): ToolEvent[] =>
      listToolEvents(database.db, task.id).filter(
        (event) =>
          (event.kind === ToolEventKind.ToolCall || event.kind === ToolEventKind.Narration) &&
          event.parentToolUseId === parent,
      )
    expect(nested(api).map((event) => event.kind)).toEqual([
      ToolEventKind.Narration,
      ToolEventKind.ToolCall,
      ToolEventKind.ToolCall,
      ToolEventKind.ToolCall,
    ])
    expect(nested(api).at(-1)).toMatchObject({ name: 'Read', state: ToolCallState.Running })
    expect(nested(dashboard).at(-1)).toMatchObject({
      kind: ToolEventKind.Narration,
      text: '#1418 moves the charts onto the new query, so it belongs under features, not fixes.',
    })
    expect(nested(links)).toHaveLength(2)
    expect(agents[2]?.output).toBe('Found 2 broken links and fixed both in the draft.')
    expect(activity()).toBe(TaskActivity.Working)

    const stopped = agent.stop(task.id)
    await vi.runAllTimersAsync()
    await expect(stopped).resolves.toMatchObject({ activity: TaskActivity.Waiting })
    expect(
      calls()
        .filter((call) => call.name === 'Agent')
        .map((call) => call.state),
    ).toEqual([ToolCallState.Error, ToolCallState.Error, ToolCallState.Done])
    expect(calls().filter((call) => call.progressSummary !== null)).toEqual([])
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
      ['Bash', ToolCallState.Interrupted],
      ['Bash', ToolCallState.Done],
      ['mcp__glade__set_status', ToolCallState.Done],
    ])
    expect(getTask(database.db, task.id)).toMatchObject({
      activity: TaskActivity.Waiting,
      status: 'The e2e suite passes.',
    })
  })

  it('long-build: keeps building until the app quits, then builds again and finishes the turn when resumed', async () => {
    await send(start('long-build'), 'Build the release.')
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(activity()).toBe(TaskActivity.Working)
    expect(calls().at(-1)).toMatchObject({ name: 'Bash', state: ToolCallState.Running })
    runner?.close()

    const resumed = start('long-build')
    resumed.resumeInterrupted()
    const idle = backend.whenIdle()
    await vi.runAllTimersAsync()
    await idle

    expect(reply()).toBe('The release is built: dist/glade-0.3.0.dmg.')
    expect(
      calls()
        .filter(({ name }) => name === 'Bash')
        .map(({ state }) => state),
    ).toEqual([ToolCallState.Interrupted, ToolCallState.Done])
    expect(getTask(database.db, task.id)).toMatchObject({
      activity: TaskActivity.Waiting,
      title: 'Build the release',
      status: 'The release is built.',
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
      ['Bash', ToolCallState.Interrupted],
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

  /** Sends the message, lets its first turn play, and answers with the task's pause. */
  async function pausedBy(agent: AgentRunner, text: string): Promise<TaskPause | null | undefined> {
    agent.send(task.id, text)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(activity()).toBe(TaskActivity.Paused)
    return getTask(database.db, task.id)?.pause
  }

  /** Lets the resumed turn play to its end. */
  async function resumeAfter(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms)
    const idle = backend.whenIdle()
    await vi.runAllTimersAsync()
    await idle
  }

  it.each([
    ['usage-limit', 6_000],
    ['usage-limit-hour', 60 * 60_000],
  ] as const)('%s: pauses on the usage limit mid-copy, then resumes when it resets and finishes', async (name, ms) => {
    const pause = await pausedBy(start(name), 'Move the uploads to S3.')

    expect(pause).toMatchObject({
      reason: PauseReason.UsageLimit,
      details: expect.stringMatching(/^You've hit your/) as unknown,
    })
    // The SDK gives the reset time to the second.
    const wait = (pause?.resumesAt ?? 0) - (pause?.since ?? 0)
    expect(wait).toBeGreaterThanOrEqual(ms)
    expect(wait).toBeLessThan(ms + 1_000)
    expect(calls().map((call) => [call.name, call.state])).toContainEqual(['Bash', ToolCallState.Done])

    await resumeAfter(wait)
    expect(reply()).toBe('The copy finished: all 3,900 files are in the bucket.')
    expect(getTask(database.db, task.id)).toMatchObject({
      activity: TaskActivity.Waiting,
      pause: null,
      status: 'All 3,900 files copied to S3.',
    })
  })

  it('offline: pauses when the network goes, then resumes once it is back and finishes', async () => {
    const pause = await pausedBy(start('offline'), 'Move the uploads to S3.')
    expect(pause).toMatchObject({ reason: PauseReason.Offline, details: 'API Error: Connection error.' })

    await resumeAfter(OFFLINE_FIRST_CHECK_MS)
    expect(reply()).toBe('The copy finished: all 3,900 files are in the bucket.')
    expect(activity()).toBe(TaskActivity.Waiting)
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
      status: 'Waiting on layout, credit and upgrade guide questions.',
      activity: TaskActivity.Waiting,
      asking: true,
    })
    expect(reply()).toBeUndefined()

    agent.answer(open?.id ?? '', { 0: 'by-type', 1: 'Internal changes', 2: 'GitHub handles', 3: ' Mention the 429s. ' })
    await vi.waitFor(() => {
      expect(activity()).toBe(TaskActivity.Waiting)
    })

    expect(reply()).toMatch(/^Thanks\. The release notes for 2\.4 are drafted/)
    expect(calls().find((call) => call.name === 'mcp__glade__ask')).toMatchObject({
      state: ToolCallState.Done,
      output: '{"0":"by-type","1":"Internal changes","2":"GitHub handles","3":"Mention the 429s."}',
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

  it('asks-permission: runs straight through in Allow all, asking nothing', async () => {
    await send(start('asks-permission'), 'Note the retry change.')

    expect(listPermissionRequests(database.db, task.id)).toEqual([])
    expect(calls().map(({ name, state }) => [name, state])).toContainEqual(['Bash', ToolCallState.Done])
    expect(reply()).toBe(ASKS_PERMISSION.reply)
  })

  it('asks-permission: in the ask mode, waits on the edit and the command in turn, then replies', async () => {
    updateTask(database.db, task.id, { permissionMode: PermissionMode.AskBeforeEdits })
    const agent = start('asks-permission')
    await sendAndWaitAnHour(agent, 'Note the retry change.')

    const [edit] = listOpenPermissionRequests(database.db, task.id)
    expect(edit).toMatchObject({ toolName: 'Edit', input: ASKS_PERMISSION.edit })
    expect(getTask(database.db, task.id)).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: true })
    // The read before it went ahead without asking.
    expect(calls().find((call) => call.name === 'Read')?.state).toBe(ToolCallState.Done)

    agent.answerPermission(edit?.id ?? '', { kind: PermissionDecisionKind.AllowOnce })
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    const [test] = listOpenPermissionRequests(database.db, task.id)
    expect(test).toMatchObject({ toolName: 'Bash', input: { command: ASKS_PERMISSION.command } })

    agent.answerPermission(test?.id ?? '', { kind: PermissionDecisionKind.AllowOnce })
    await vi.waitFor(() => {
      expect(reply()).toBe(ASKS_PERMISSION.reply)
    })
    expect(listPermissionRequests(database.db, task.id).map(({ state }) => state)).toEqual([
      PermissionRequestState.Allowed,
      PermissionRequestState.Allowed,
    ])
    expect(getTask(database.db, task.id)).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: false })
  })

  describe('allows-for-task', () => {
    /** The open requests' calls, as `Tool: command or file`. */
    const open = (taskId = task.id): string[] =>
      listOpenPermissionRequests(database.db, taskId).map(
        ({ toolName, input }) => `${toolName}: ${String(input.command ?? input.file_path)}`,
      )

    /** Answers the one open request, and lets the script play on to the next, or its end. */
    async function answerOpen(agent: AgentRunner, decision: PermissionDecision): Promise<void> {
      const [request] = listOpenPermissionRequests(database.db, task.id)
      agent.answerPermission(request?.id ?? '', decision)
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    }

    const { command, watch, compound, edit, editAgain } = ALLOWS_FOR_TASK

    it('stops asking about what a granted rule covers, and still asks about a compound command', async () => {
      updateTask(database.db, task.id, { permissionMode: PermissionMode.AskBeforeEdits })
      const agent = start('allows-for-task')
      await sendAndWaitAnHour(agent, 'Run the tests.')

      expect(open()).toEqual([`Bash: ${command}`])
      await answerOpen(agent, { kind: PermissionDecisionKind.AllowForTask })
      // `npm test -- --watch` ran without asking; `npm test && rm -rf build` asks.
      expect(open()).toEqual([`Bash: ${compound}`])
      expect(calls().find(({ input }) => input.command === watch)?.state).toBe(ToolCallState.Done)
      await answerOpen(agent, { kind: PermissionDecisionKind.AllowOnce })
      expect(open()).toEqual([`Edit: ${edit.file_path}`])
      await answerOpen(agent, { kind: PermissionDecisionKind.AllowForTask })

      await vi.waitFor(() => {
        expect(reply()).toBe(ALLOWS_FOR_TASK.reply)
      })
      expect(
        listPermissionRequests(database.db, task.id).map(({ toolName, grantedRule }) => [toolName, grantedRule]),
      ).toEqual([
        ['Bash', { toolName: 'Bash', ruleContent: 'npm test *' }],
        ['Bash', null],
        ['Edit', { toolName: 'Edit' }],
      ])
      expect(calls().find(({ input }) => input.file_path === editAgain.file_path)?.state).toBe(ToolCallState.Done)
    })

    it("keeps the task's rules across a relaunch, and gives another task none of them", async () => {
      updateTask(database.db, task.id, { permissionMode: PermissionMode.AskBeforeEdits })
      const agent = start('allows-for-task')
      await sendAndWaitAnHour(agent, 'Run the tests.')
      await answerOpen(agent, { kind: PermissionDecisionKind.AllowForTask })
      await answerOpen(agent, { kind: PermissionDecisionKind.Deny })
      await answerOpen(agent, { kind: PermissionDecisionKind.AllowForTask })
      await vi.waitFor(() => {
        expect(activity()).toBe(TaskActivity.Waiting)
      })
      runner?.close()

      // The next launch's session resumes with the rules: only the compound command asks.
      const relaunched = start('allows-for-task')
      await sendAndWaitAnHour(relaunched, 'Run them again.')
      expect(open()).toEqual([`Bash: ${compound}`])
      await answerOpen(relaunched, { kind: PermissionDecisionKind.AllowOnce })
      expect(open()).toEqual([])
      expect(listPermissionRequests(database.db, task.id)).toHaveLength(4)

      // Another task, in the ask mode too, asks about everything.
      const other = sampleTask(database.db, task.workspaceId)
      updateTask(database.db, other.id, { permissionMode: PermissionMode.AskBeforeEdits })
      relaunched.send(other.id, 'Run the tests.')
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
      expect(open(other.id)).toEqual([`Bash: ${command}`])
    })
  })

  it('permission-at-quit: allowed after a relaunch, the resumed agent runs the command again without asking', async () => {
    updateTask(database.db, task.id, { permissionMode: PermissionMode.AskBeforeEdits })
    const agent = start('permission-at-quit')
    await sendAndWaitAnHour(agent, 'Run the migrations.')
    const [open] = listOpenPermissionRequests(database.db, task.id)
    expect(open).toMatchObject({ toolName: 'Bash', input: { command: PERMISSION_AT_QUIT.command } })
    runner?.close()

    const relaunched = start('permission-at-quit')
    relaunched.resumeInterrupted()
    expect(listOpenPermissionRequests(database.db, task.id)).toEqual([open])
    relaunched.answerPermission(open?.id ?? '', { kind: PermissionDecisionKind.AllowOnce })
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    expect(reply()).toBe(PERMISSION_AT_QUIT.reply)
    expect(listPermissionRequests(database.db, task.id)).toHaveLength(1)
    expect(calls().map(({ name, state, output }) => [name, state, output])).toContainEqual([
      'Bash',
      ToolCallState.Done,
      PERMISSION_AT_QUIT.output,
    ])
    expect(calls().find((call) => call.name === 'Bash')?.state).toBe(ToolCallState.Interrupted)
    expect(activity()).toBe(TaskActivity.Waiting)
  })

  it('keeps-todos: plans with TaskCreate, checks items off with TaskUpdate, and asks partway through', async () => {
    const agent = start('keeps-todos')
    await sendAndWaitAnHour(agent, 'Move the image uploads to S3.')

    const states = (): TodoState[] | undefined => todoListFor(database.db, task.id)?.items.map(({ state }) => state)
    const { Done, Doing, Todo } = TodoState
    const open = getOpenQuestionSet(database.db, task.id)
    expect(open?.questions).toEqual([DELETE_LOCAL_COPIES_QUESTION])
    expect(todoListFor(database.db, task.id)?.items.map(({ text }) => text)).toEqual(
      S3_PLAN.map((item) => item.subject),
    )
    expect(states()).toEqual([Done, Done, Done, Doing, Todo, Todo, Todo])
    expect(todoListFor(database.db, task.id)?.items[3]?.note).toBe('Copying files · 1,240 of 3,900')

    agent.answer(open?.id ?? '', { 0: 'Keep them for now' })
    await vi.waitFor(() => {
      expect(reply()).toMatch(/^All 3,900 files are on S3/)
    })
    expect(states()).toEqual([Done, Done, Done, Done, Done, Done, Todo])
    expect(calls().filter(({ name }) => name === 'TaskCreate')).toHaveLength(7)
  })

  it('writes-todos: keeps its list with TodoWrite, checking each item off', async () => {
    await send(start('writes-todos'), 'Fix the flaky login test.')

    expect(reply()).toMatch(/passes 200 runs in a row\.$/)
    expect(todoListFor(database.db, task.id)?.items).toEqual([
      { text: 'Reproduce the flake', state: TodoState.Done, note: null },
      { text: 'Fix the race', state: TodoState.Done, note: null },
      { text: 'Run the test 200 times', state: TodoState.Done, note: null },
    ])
    expect(calls().filter(({ name }) => name === 'TodoWrite')).toHaveLength(3)
  })

  it('finishes-in-background: reports back in a turn of its own when the build finishes, with no message from you', async () => {
    // Regression (#162): the turn the agent started on its own was dropped, text, tool calls, reply and all.
    // The chat's messages and the task's activity changes, in the order they were broadcast.
    const heard: string[] = []
    let activity: TaskActivity | null = null
    const emit = (event: GladeEvent): void => {
      if (event.type === EventType.MessageAppended) heard.push(`${event.message.role}: ${event.message.body}`)
      if (event.type === EventType.TaskUpdated && activity !== event.task.activity) {
        activity = event.task.activity
        heard.push(activity)
      }
    }
    const notifyReply = vi.fn<NotifyReply>()
    // You're looking elsewhere, so the reply marks the task unread and is notified.
    await send(start('finishes-in-background', { emit, notifyReply }), 'Build the docs.')

    const selfStarted = 'The docs site built cleanly: 48 pages and no broken links.'
    expect(listMessages(database.db, task.id).map(({ role, body, turn }) => [role, turn, body])).toEqual([
      [MessageRole.User, 1, 'Build the docs.'],
      [MessageRole.Agent, 1, "I've started the docs build in the background. I'll report back when it finishes."],
      [MessageRole.Agent, 2, selfStarted],
    ])
    expect(listMessages(database.db, task.id).at(-1)?.summary).toEqual({
      durationMs: expect.any(Number) as number,
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
    })
    const turnTwo = listToolEvents(database.db, task.id).filter((event) => event.turn === 2)
    expect(turnTwo.map((event) => event.kind)).toEqual([
      ToolEventKind.Divider,
      ToolEventKind.Narration,
      ToolEventKind.ToolCall,
      ToolEventKind.ToolCall,
    ])
    expect(turnTwo[0]).toMatchObject({ dividerKind: DividerKind.Turn })
    expect(turnTwo.slice(1)).toMatchObject([
      { text: 'The docs build finished. Checking its output for broken links.' },
      { name: 'Read', state: ToolCallState.Done },
      { name: 'mcp__glade__set_status', state: ToolCallState.Done },
    ])
    // It works through the turn, and waits on you once it has replied.
    expect(
      heard.slice(
        heard.indexOf(
          `${MessageRole.Agent}: I've started the docs build in the background. I'll report back when it finishes.`,
        ),
      ),
    ).toEqual([
      `${MessageRole.Agent}: I've started the docs build in the background. I'll report back when it finishes.`,
      TaskActivity.Waiting,
      TaskActivity.Working,
      `${MessageRole.Agent}: ${selfStarted}`,
      TaskActivity.Waiting,
    ])
    expect(getTask(database.db, task.id)).toMatchObject({
      status: 'The docs site is built, with no broken links.',
      unread: true,
      activity: TaskActivity.Waiting,
    })
    expect(notifyReply).toHaveBeenLastCalledWith(task.id, selfStarted)

    // The next message is the next turn.
    await send(runner ?? start('finishes-in-background'), 'Where is it?')
    expect(
      listMessages(database.db, task.id)
        .slice(-2)
        .map(({ role, turn }) => [role, turn]),
    ).toEqual([
      [MessageRole.User, 3],
      [MessageRole.Agent, 3],
    ])
  })

  describe('follow-ups the agent schedules itself (docs/sdk-notes.md §11)', () => {
    interface FollowUp {
      readonly name: AgentScriptName
      readonly message: string
      /** The reply to the message, which ends the turn that schedules the follow-up. */
      readonly scheduled: string
      /** What the agent says as it starts the turn the follow-up wakes it for. */
      readonly checking: string
      /** Its reply in that turn. */
      readonly reported: string
      /** The Bash call that turn makes, which a Stop cuts short. */
      readonly command: string
    }
    const FOLLOW_UP_SCRIPTS: readonly FollowUp[] = [
      {
        name: 'watches-ci',
        message: 'Watch CI on PR #42.',
        scheduled: FOLLOW_UPS.watching,
        checking: FOLLOW_UPS.checkFailed,
        reported: FOLLOW_UPS.failed,
        command: 'gh run view 8812 --log-failed',
      },
      {
        name: 'checks-back-later',
        message: 'Deploy the docs.',
        scheduled: FOLLOW_UPS.deploying,
        checking: FOLLOW_UPS.checkingDeploy,
        reported: FOLLOW_UPS.deployed,
        command: 'npm run deploy:status',
      },
      {
        name: 'scheduled-check',
        message: 'Check the staging migration at 2:30.',
        scheduled: FOLLOW_UPS.scheduled,
        checking: FOLLOW_UPS.checkingMigration,
        reported: FOLLOW_UPS.migrated,
        command: 'npm run db:status -- --env staging',
      },
    ]

    /** The chat as `[role, turn, body]`. */
    function chat(): [MessageRole, number, string][] {
      return listMessages(database.db, task.id).map(({ role, body, turn }) => [role, turn, body])
    }

    it.each(FOLLOW_UP_SCRIPTS)(
      '$name: the follow-up wakes the agent into a turn of its own, saved, unread and notified',
      async ({ name, message, scheduled, checking, reported }) => {
        const notifyReply = vi.fn<NotifyReply>()
        await send(start(name, { notifyReply }), message)

        expect(chat().slice(0, 3)).toEqual([
          [MessageRole.User, 1, message],
          [MessageRole.Agent, 1, scheduled],
          [MessageRole.Agent, 2, reported],
        ])
        const turnTwo = listToolEvents(database.db, task.id).filter((event) => event.turn === 2)
        expect(turnTwo[0]).toMatchObject({ kind: ToolEventKind.Divider, dividerKind: DividerKind.Turn })
        expect(turnTwo[1]).toMatchObject({ kind: ToolEventKind.Narration, text: checking })
        expect(turnTwo.slice(2)).toMatchObject([
          { name: 'Bash', state: ToolCallState.Done },
          { name: 'mcp__glade__set_status', state: ToolCallState.Done },
        ])
        expect(listMessages(database.db, task.id)[2]?.summary).toMatchObject({ filesChanged: 0 })
        expect(getTask(database.db, task.id)).toMatchObject({ unread: true, activity: TaskActivity.Waiting })
        expect(notifyReply).toHaveBeenCalledWith(task.id, reported)
      },
    )

    it('watches-ci: the watch ending wakes the agent once more, into the turn after', async () => {
      const notifyReply = vi.fn<NotifyReply>()
      await send(start('watches-ci', { notifyReply }), 'Watch CI on PR #42.')

      expect(chat().slice(2)).toEqual([
        [MessageRole.Agent, 2, FOLLOW_UPS.failed],
        [MessageRole.Agent, 3, FOLLOW_UPS.runDone],
      ])
      // The Monitor call returned as soon as the watch started: it's done, not left running for the watch.
      expect(calls().find(({ name }) => name === 'Monitor')).toMatchObject({ state: ToolCallState.Done, turn: 1 })
      expect(notifyReply.mock.calls.map(([, reply]) => reply)).toEqual([
        FOLLOW_UPS.watching,
        FOLLOW_UPS.failed,
        FOLLOW_UPS.runDone,
      ])
    })

    it.each(FOLLOW_UP_SCRIPTS)(
      '$name: Stop cuts short the turn the follow-up woke the agent for',
      async ({ name, message, scheduled, checking, command }) => {
        const agent = start(name)
        agent.send(task.id, message)
        // Until the woken turn is running its command.
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(50)
          expect(calls().find(({ input }) => input.command === command)).toMatchObject({
            state: ToolCallState.Running,
          })
        })
        expect(activity()).toBe(TaskActivity.Working)

        const stopped = agent.stop(task.id)
        await vi.advanceTimersByTimeAsync(0)
        await expect(stopped).resolves.toMatchObject({ activity: TaskActivity.Waiting })

        // What the turn did is kept, its command ends stopped, and it has no reply.
        expect(chat().slice(0, 2)).toEqual([
          [MessageRole.User, 1, message],
          [MessageRole.Agent, 1, scheduled],
        ])
        expect(calls().find(({ input }) => input.command === command)).toMatchObject({
          state: ToolCallState.Error,
          output: STOPPED_NOTE,
          turn: 2,
        })
        expect(
          listToolEvents(database.db, task.id)
            .filter((event) => event.turn === 2 && event.kind === ToolEventKind.Narration)
            .map((event) => (event.kind === ToolEventKind.Narration ? event.text : null)),
        ).toEqual([checking, STOPPED_NOTE])
        // The agent took nothing more from it: nothing replies in turn 2 however long it's left.
        const idle = backend.whenIdle()
        await vi.runAllTimersAsync()
        await idle
        expect(chat().filter(([, turn]) => turn === 2)).toEqual([])
      },
    )

    it("watches-ci: stopping the turn a check woke doesn't end the watch, which still wakes the agent", async () => {
      const agent = start('watches-ci')
      agent.send(task.id, 'Watch CI on PR #42.')
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(50)
        expect(calls().find(({ name }) => name === 'Bash')).toMatchObject({ state: ToolCallState.Running })
      })
      const stopped = agent.stop(task.id)
      await vi.advanceTimersByTimeAsync(0)
      await stopped

      const idle = backend.whenIdle()
      await vi.runAllTimersAsync()
      await idle
      expect(chat().slice(2)).toEqual([[MessageRole.Agent, 3, FOLLOW_UPS.runDone]])
      expect(activity()).toBe(TaskActivity.Waiting)
    })
  })

  it('subagent-calls: logs each subagent’s calls under it, nested, interleaved, failed and in the background', async () => {
    const agent = start('subagent-calls')
    await send(agent, 'Draft the 2.4 release notes.')

    expect(reply()).toBe(SUBAGENT_CALLS_REPLY)
    const all = calls()
    const idOf = (name: string): string => {
      const found = all.find((call) => call.input.description === name)
      if (found === undefined) throw new Error(`No subagent ${name}`)
      return found.toolUseId
    }
    const under = (parent: string | null): string[] =>
      all
        .filter((call) => call.parentToolUseId === parent)
        .map((call) => `${call.name} ${String(Object.values(call.input)[0])} (${call.state})`)

    expect(under(null)).toEqual([
      'mcp__glade__set_title Draft release notes for 2.4 (done)',
      'mcp__glade__set_objective Draft release notes for 2.4 from the PRs merged since the 2.3 tag. (done)',
      'mcp__glade__set_status Sorting the PRs with two subagents. (done)',
      'Read CHANGELOG.md (done)',
      'Agent API changes (done)',
      'Agent Dashboard changes (done)',
      'Write docs/releases/2.4.md (done)',
      'Agent Check links in the 2.3 notes (done)',
      'mcp__glade__set_status Drafted the 2.4 notes. (done)',
    ])
    expect(under(idOf('API changes'))).toEqual([
      'Bash gh pr list --label api --state merged (done)',
      'Agent Read PR 1402 (done)',
    ])
    expect(under(idOf('Read PR 1402'))).toEqual([
      'Bash gh pr view 1402 --json title,body (done)',
      'Read api/throttles.py (done)',
    ])
    expect(under(idOf('Dashboard changes'))).toEqual([
      'Bash redis-cli -h staging-cache info stats (error)',
      'Bash gh pr list --label dashboard (done)',
      'Read web/charts.ts (done)',
    ])
    expect(under(idOf('Check links in the 2.3 notes'))).toEqual([
      'Read docs/releases/2.3.md (done)',
      'Bash curl -sI https://example.com/docs/limits (done)',
    ])
    const notes = listToolEvents(database.db, task.id).filter((event) => event.kind === ToolEventKind.Narration)
    expect(notes).toMatchObject([{ text: 'Listing the merged API PRs.', parentToolUseId: idOf('API changes') }])
  })
})
