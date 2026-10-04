// The todo hub is built dark (P16, #491): until its last issue (#501) turns the hidden `todoHubEnabled` setting on, the
// app must behave exactly as it did before the phase. This holds that, with the setting as it starts (off), through
// the real wiring: a session starts with the tools, prompt and hooks it had, scripted agents that make every kind of
// child (todos, files, links, subagents, watchers) never touch the hub's tables or send its event, and its commands
// answer nothing. Each later issue of the phase keeps this passing.
//
// P16-04 (#495) files children as they're made: with the setting off, `add_artifact` takes no todo, the prompt has
// none of its lines, no hook reads a marker, asks the agent to file anything or holds the end of a turn, and Claude
// Code's task tools are left to the user's settings.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { CommandName, EventType, type GladeEvent } from '../../shared/bridge'
import { ArtifactKind, MessageRole, ToolEventKind, type Task, type ToolCallEvent } from '../../shared/domain'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { isSubagentTool } from '../../shared/subagents'
import { FakeAgentBackend, settle } from '../agent/fake-backend'
import { createGladeMcpServer, GLADE_SERVER } from '../agent/glade-tools'
import { createAgentRunner, type AgentRunner } from '../agent/runner'
import { AGENT_SCRIPTS, FILES_CHILDREN, type AgentScriptName } from '../agent/scripts'
import { sdkOptions } from '../agent/sdk-backend'
import { createTestModeAgentBackend, type TestModeAgentBackend } from '../agent/test-mode-backend'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { listArtifacts } from '../db/repositories/artifacts'
import { listMessages } from '../db/repositories/messages'
import { getSessionContext } from '../db/repositories/session-context'
import { getSettings } from '../db/repositories/settings'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { listToolEvents } from '../db/repositories/tool-events'
import { listWatchers } from '../db/repositories/watchers'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { createQuestionBroker } from '../questions/questions'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { todoListFor } from '../todos/todos'

let database: TestDatabase
let db: Database
let task: Task
let runner: AgentRunner | undefined
let backend: TestModeAgentBackend
let events: GladeEvent[]
/** Every statement prepared on the database since the test began. */
let statements: string[]
const folders: string[] = []

/** Glade's tools as the app gave every session before the phase. */
const TOOLS_BEFORE = [
  'set_title',
  'set_objective',
  'set_status',
  'ask',
  'show_file',
  'add_artifact',
  'update_artifact',
  'remove_artifact',
  'request_access',
]

/** The session hooks Glade set before the phase, for a task as it starts (Allow all, outside the sandbox). */
const HOOKS_BEFORE = ['onBashStarting', 'onCompacted', 'onPrompt', 'onTurnEnded']

/** The lines the hub's prompt will have, as #492 probed them: none may reach a session while the hub is off. */
const HUB_PROMPT = /file_children|under one of your todos|\[todo \d+\]|Glade files everything you make/i

/** Every event main sent before the phase. */
const EVENTS_BEFORE: readonly EventType[] = Object.values(EventType).filter((type) => type !== EventType.FilingsChanged)

const HUB_TABLES = /child_ids|child_filings|todo_panels|owed_filings/

/** The SDK hooks Glade registered before the phase, for a task as it starts. */
const SDK_HOOKS_BEFORE = ['PreToolUse', 'UserPromptSubmit', 'Stop', 'PostCompact']

function watch(database_: Database): void {
  const prepare = database_.prepare.bind(database_)
  database_.prepare = (sql: string) => {
    statements.push(sql)
    return prepare(sql)
  }
}

beforeEach(() => {
  database = openTestDatabase()
  db = database.db
  task = sampleTask(db, sampleWorkspace(db).id)
  events = []
  statements = []
  watch(db)
})

afterEach(() => {
  runner?.close()
  runner = undefined
  database.close()
  vi.useRealTimers()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

/** A runner on a scripted agent, with the real Glade tools, as the app gives every session. */
function start(name: AgentScriptName): AgentRunner {
  backend = createTestModeAgentBackend({ script: AGENT_SCRIPTS[name] })
  const base = {
    db,
    emit: (event: GladeEvent) => {
      events.push(event)
    },
  }
  const context = { ...base, questions: createQuestionBroker(base) }
  runner = createAgentRunner({
    ...context,
    backend,
    mcpServers: (forTask) => ({ [GLADE_SERVER]: createGladeMcpServer(context, forTask.id) }),
  })
  return runner
}

/** Sends a message and lets the script play it out, however long its delays are. */
async function play(name: AgentScriptName, text: string): Promise<void> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  start(name).send(task.id, text)
  const idle = backend.whenIdle()
  await vi.runAllTimersAsync()
  await idle
}

/** What the hub must not have done while it's off. */
function expectUntouched(): void {
  expect(statements.filter((sql) => HUB_TABLES.test(sql))).toEqual([])
  expect(events.filter(({ type }) => !EVENTS_BEFORE.includes(type))).toEqual([])
  expect(events.length).toBeGreaterThan(0)
  // Looked at only now, the statements having been checked.
  const rows = `SELECT (SELECT COUNT(*) FROM child_ids) + (SELECT COUNT(*) FROM child_filings)
    + (SELECT COUNT(*) FROM todo_panels) + (SELECT COUNT(*) FROM owed_filings)`
  expect(db.prepare(rows).pluck().get()).toBe(0)
}

describe('with the todo hub off, as it starts', () => {
  it('is off unless the setting was turned on', () => {
    expect(DEFAULT_SETTINGS.todoHubEnabled).toBe(false)
    expect(getSettings(db).todoHubEnabled).toBe(false)
  })

  it('starts a session with the tools, the prompt and the hooks it had before', async () => {
    const agents = new FakeAgentBackend()
    const ipc = fakeIpcPair()
    registerBridge({
      ipc: ipc.main,
      db,
      targets: () => [ipc.window],
      chooseFolder: () => Promise.resolve(null),
      openPath: () => Promise.resolve(''),
      revealPath: () => undefined,
      writeClipboard: () => Promise.resolve(),
      terminal: fakeTerminalOptions(),
      pluginsFolder: UNREAD_PLUGINS_FOLDER,
      agentBackend: agents,
    })
    const glade = createBridge(ipc.renderer)
    glade.subscribe((event) => events.push(event))

    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Move the image uploads to S3.' })
    await settle()

    const { options } = agents.session
    expect(Object.keys(options.mcpServers)).toEqual([GLADE_SERVER])
    const server = options.mcpServers[GLADE_SERVER]
    if (server?.type !== 'sdk') throw new Error('Glade’s tools aren’t an in-process server')
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.instance.connect(serverSide)
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(clientSide)
    const { tools } = await client.listTools()
    expect(tools.map(({ name }) => name)).toEqual(TOOLS_BEFORE)
    // `add_artifact` takes what it took: no todo, and its description says nothing of one.
    const addArtifact = tools.find(({ name }) => name === 'add_artifact')
    expect(Object.keys(addArtifact?.inputSchema.properties ?? {})).toEqual(['path', 'url', 'title'])
    expect(addArtifact?.description).not.toMatch(/todo/i)
    await client.close()

    expect(Object.keys(options.hooks ?? {}).sort()).toEqual(HOOKS_BEFORE)
    expect(options.systemPromptAppend).not.toMatch(HUB_PROMPT)
    // Nothing ahead of its message either, and its session isn't recorded as told of the hub.
    expect(agents.session.sent.map(({ text }) => text)).toEqual(['Move the image uploads to S3.'])
    expect(getSessionContext(db, task.id)?.todoHub).toBe(false)
    // What the SDK is given is what it was: no hook that reads a call, hears of a message's calls or holds a turn,
    // and Claude Code's task tools left to the user's own settings.
    expect(options.keepTaskTools).toBeUndefined()
    const sdk = sdkOptions(options, {})
    expect(Object.keys(sdk.hooks ?? {})).toEqual(SDK_HOOKS_BEFORE)
    expect(sdk.hooks?.PreToolUse?.map(({ matcher }) => matcher)).toEqual([undefined, 'Bash'])
    expect(sdk.settings).toEqual({ deniedMcpServers: [{ serverName: 'glade-control' }] })
    expectUntouched()
  })

  it('reads no marker, asks the agent to file nothing and holds no turn, for an agent that names todos and one that names none', async () => {
    const root = mkdtempSync(join(tmpdir(), 'glade-todo-hub-inert-'))
    folders.push(root)
    task = sampleTask(db, sampleWorkspace(db, root).id)
    // Real timers: its commits are real commands, which fake timers would race with.
    const agent = start('files-children')
    agent.send(task.id, FILES_CHILDREN.prompt)
    await backend.whenIdle()
    agent.send(task.id, 'And the order totals.')
    await backend.whenIdle()

    const calls = listToolEvents(db, task.id).filter(
      (event): event is ToolCallEvent => event.kind === ToolEventKind.ToolCall,
    )
    // Each call ran, and is logged, as the model wrote it: nothing took its marker off.
    const marked = calls.filter(({ input }) =>
      Object.values(input).some((value) => /^\[todo \d\] /.test(String(value))),
    )
    expect(marked.map(({ name }) => name)).toEqual(['Agent', 'Bash', 'Monitor', 'Bash', 'ScheduleWakeup', 'CronCreate'])
    expect(listWatchers(db, task.id).map(({ label }) => label)).toContain('[todo 3] CI checks on PR #42')
    // The second turn named no todo, and nothing asked: the agent made no filing call, and each turn ended on its
    // one reply.
    expect(calls.map(({ name }) => name)).not.toContain('mcp__glade__file_children')
    const replies = listMessages(db, task.id).filter(({ role }) => role === MessageRole.Agent)
    expect(replies.map(({ body }) => body)).toEqual([FILES_CHILDREN.named.reply, FILES_CHILDREN.unnamed.reply])
    // No reply was written twice: none of the agent's own text went to the tool log as a held turn's would.
    const narrated = listToolEvents(db, task.id).flatMap((event) =>
      event.kind === ToolEventKind.Narration && event.parentToolUseId === null ? [event.text] : [],
    )
    expect(narrated).toEqual([])
    // Its artifacts were declared with no todo taken.
    expect(listArtifacts(db, task.id)).toHaveLength(2)
    expectUntouched()
  })

  it('keeps a todo list with TaskCreate and TaskUpdate without filing or numbering anything', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    start('keeps-todos').send(task.id, 'Move the image uploads to S3.')
    // The script asks a question partway and waits on it: an hour is plenty to get there.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    // Each todo has the id Claude Code gave it, which is all of the phase that shows with the hub off.
    expect(todoListFor(db, task.id)?.items.map(({ id }) => id)).toEqual(['1', '2', '3', '4', '5', '6', '7'])
    expectUntouched()
  })

  it('keeps one with TodoWrite, whose items have no id', async () => {
    await play('writes-todos', 'Fix the flaky login test.')

    expect(todoListFor(db, task.id)?.items.map(({ id }) => id)).toEqual([null, null, null])
    expectUntouched()
  })

  it('runs subagents without filing or numbering them', async () => {
    await play('parallel-subagents', 'Draft the 2.4 release notes.')

    const subagents = listToolEvents(db, task.id).filter(
      (event) => event.kind === ToolEventKind.ToolCall && isSubagentTool(event.name),
    )
    expect(subagents).toHaveLength(3)
    expectUntouched()
  })

  it('starts a watcher without filing or numbering it', async () => {
    await play('watches-ci', 'Watch CI on PR #42.')

    expect(listWatchers(db, task.id)).toHaveLength(1)
    expectUntouched()
  })

  it('declares a file and links as artifacts, with no todo asked for, without filing or numbering them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'glade-todo-hub-inert-'))
    folders.push(root)
    mkdirSync(join(root, 'docs', 'releases'), { recursive: true })
    writeFileSync(join(root, 'docs', 'releases', '2.4.md'), '# Release notes 2.4\n')
    task = sampleTask(db, sampleWorkspace(db, root).id)
    // Real timers: `add_artifact` reads the disk, which fake timers would race with the tool call's timeout.
    start('tracks-links').send(task.id, 'Open a PR for the docs navigation.')
    await backend.whenIdle()

    const kinds = listArtifacts(db, task.id).map(({ kind }) => kind)
    expect(kinds).toContain(ArtifactKind.File)
    expect(kinds).toContain(ArtifactKind.Link)
    expectUntouched()
  })
})
