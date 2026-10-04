// Filing what an agent produces under its todos as it's made (P16-04, #495), through the runner: a session that
// starts with the todo hub on streams its calls and asks its three hooks in the order the SDK was probed to
// (`docs/sdk-notes.md` §16), with the real Glade tools and a database in memory. Commits are filed, a subagent's todo
// is recorded, and a watcher's call is left as it is. Each test reads where main puts each thing.
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventType, type GladeEvent } from '../../shared/bridge'
import { MessageRole, ToolEventKind, type Task, type ToolCallEvent, type ToolInput } from '../../shared/domain'
import { subagentTodo, subagentTodos } from '../../shared/todoHub'
import { FILE_CHILDREN_TOOL } from '../../shared/toolName'
import type { BashEnd, ChangeTracker } from '../changes/tracker'
import { listFilings } from '../db/repositories/child-filings'
import { listMessages } from '../db/repositories/messages'
import { listOwedFilings } from '../db/repositories/owed-filings'
import { getSessionContext } from '../db/repositories/session-context'
import { getSettings, updateSettings } from '../db/repositories/settings'
import { addTaskCommit, CommitSource, listTaskCommits } from '../db/repositories/task-commits'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { listToolEvents } from '../db/repositories/tool-events'
import { listWatchers } from '../db/repositories/watchers'
import { createGit } from '../git/git'
import { openTestRepos, TEST_GIT_RUN, type TestRepos } from '../git/test-repos'
import { createQuestionBroker } from '../questions/questions'
import { NO_TODOS } from '../todo-hub/agent-children'
import { readTodoHub, taskChildren } from '../todo-hub/todo-hub'
import type { BatchCall } from './backend'
import { readsTodo } from './child-calls'
import { FakeAgentBackend, settle, type FakeAgentSession } from './fake-backend'
import { createGladeMcpServer, GLADE_SERVER } from './glade-tools'
import { COMPACT_COMMAND, createAgentRunner, type AgentRunner } from './runner'
import { INSTRUCTION_UPDATES, TODO_HUB_LINES } from './system-prompt'
import * as sdk from './test-sdk-messages'

let database: TestDatabase
let db: Database
let task: Task
let backend: FakeAgentBackend
let runner: AgentRunner
let events: GladeEvent[]

// Some tests run real git commands: slow while the whole suite runs at once.
vi.setConfig({ testTimeout: 30_000 })

/** A tracker that works out no commit, and remembers what it was told ran. */
function quietTracker(onFinished: (call: BashEnd) => void = () => undefined): ChangeTracker {
  return {
    bashStarting: () => Promise.resolve(),
    bashFinished: (_taskId, call) => {
      onFinished(call)
      return Promise.resolve()
    },
    sessionEnded: () => undefined,
  }
}

/**
 * A tracker that finds a commit, once, after each of the `Bash` calls named, the agent's or a subagent's, as git would
 * once the call's result is in: the character its hash is made of, and its subject, by the call's id.
 */
function committing(commits: Readonly<Record<string, readonly [string, string]>>): ChangeTracker {
  const made = new Set<string>()
  return quietTracker(({ toolUseId }) => {
    const [hash, subject] = commits[toolUseId] ?? []
    if (hash === undefined || subject === undefined || made.has(toolUseId)) return
    made.add(toolUseId)
    addTaskCommit(db, {
      taskId: task.id,
      gitDir: '/code/acme-api/.git',
      repoPath: '/code/acme-api',
      hash: hash.repeat(40),
      subject,
      branch: 'main',
      committedAt: Date.now(),
      additions: 1,
      deletions: 1,
      filesChanged: 1,
      parents: 1,
      toolUseId,
      source: CommitSource.Printed,
    })
  })
}

/**
 * Starts a runner on the database, as a launch does, with the real Glade tools for each session. Given null for its
 * tracker, it makes its own, as the app's does, reading git with none of the machine's config.
 */
function launch(changes: ChangeTracker | null = quietTracker()): void {
  backend = new FakeAgentBackend()
  const base = { db, emit: (event: GladeEvent) => events.push(event) }
  const context = { ...base, questions: createQuestionBroker(base) }
  runner = createAgentRunner({
    ...context,
    backend,
    ...(changes === null ? { git: createGit(TEST_GIT_RUN) } : { changes }),
    mcpServers: (forTask) => ({ [GLADE_SERVER]: createGladeMcpServer(context, forTask.id, getSettings(db)) }),
  })
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  database = openTestDatabase()
  db = database.db
  task = sampleTask(db, sampleWorkspace(db).id)
  events = []
  updateSettings(db, { todoHubEnabled: true })
  launch()
})

afterEach(() => {
  runner.close()
  database.close()
  vi.restoreAllMocks()
})

const session = (): FakeAgentSession => backend.session

/** Sends a message, and has the session start its turn. */
async function say(text: string): Promise<void> {
  runner.send(task.id, text)
  session().emit(sdk.init())
  await settle()
}

/** `TaskCreate` calls and their results, as Claude Code gives a todo its id. */
function todos(...subjects: string[]): unknown[] {
  return subjects.flatMap((subject, index) => {
    const id = String(index + 1)
    return [
      sdk.toolUse(`toolu_create_${id}`, 'TaskCreate', { subject }),
      sdk.toolResult(`toolu_create_${id}`, `Task #${id} created successfully: ${subject}`),
    ]
  })
}

async function threeTodos(): Promise<void> {
  session().emit(...todos('Review the date helpers', 'Fix the UTC date test', 'Watch CI on PR #42'))
  await settle()
}

/** The SDK starting a task for a call, with the description it has of it. */
function taskStarted(toolUseId: string, sdkTaskId: string, description: string, taskType = 'local_bash'): unknown {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: sdkTaskId,
    tool_use_id: toolUseId,
    description,
    is_backgrounded: true,
    task_type: taskType,
    session_id: sdk.SESSION_ID,
  }
}

/** A result with what the SDK says of it beside its text. */
function resultWith(toolUseId: string, text: string, details: Record<string, unknown>): unknown {
  return { ...(sdk.toolResult(toolUseId, text) as object), tool_use_result: details }
}

/**
 * The agent's own call, as the SDK plays it: the `tool_use` as the model wrote it, the `PreToolUse` hook for a call a
 * todo is read off (an `Agent` call, a `Bash` call in the foreground), then what the tool does with the input the hook
 * handed back (`ran`). Answers that input: a watcher's call reaches no hook, and runs as written.
 */
async function calls(
  toolUseId: string,
  name: string,
  input: ToolInput,
  ran: (input: ToolInput) => unknown[],
): Promise<ToolInput> {
  session().emit(sdk.toolUse(toolUseId, name, input))
  const hooked = readsTodo({ toolName: name, input, subagent: false })
  const handed =
    (hooked ? await session().startChild({ toolName: name, input, toolUseId, agentId: null }) : null) ?? input
  session().emit(...ran(handed))
  await settle()
  return handed
}

const text = (input: ToolInput, field: string): string => String(input[field])

function subagent(toolUseId: string, input: ToolInput): Promise<ToolInput> {
  return calls(toolUseId, 'Agent', { ...input, run_in_background: true }, (ran) => [
    taskStarted(toolUseId, `a_${toolUseId}`, text(ran, 'description'), 'local_agent'),
    sdk.launchedResult(toolUseId, `a_${toolUseId}`),
  ])
}

function monitor(toolUseId: string, input: ToolInput): Promise<ToolInput> {
  return calls(toolUseId, 'Monitor', input, (ran) => [
    taskStarted(toolUseId, `b_${toolUseId}`, text(ran, 'description')),
    resultWith(toolUseId, 'Monitor started.', { taskId: `b_${toolUseId}`, timeoutMs: 60_000, persistent: false }),
  ])
}

function command(toolUseId: string, input: ToolInput): Promise<ToolInput> {
  return calls(toolUseId, 'Bash', { ...input, run_in_background: true }, (ran) => [
    taskStarted(toolUseId, `b_${toolUseId}`, text(ran, 'description')),
    resultWith(toolUseId, 'Command running in background.', { stdout: '', backgroundTaskId: `b_${toolUseId}` }),
  ])
}

function wakeup(toolUseId: string, input: ToolInput): Promise<ToolInput> {
  return calls(toolUseId, 'ScheduleWakeup', input, () => [
    resultWith(toolUseId, 'Next wakeup scheduled (in 300s).', { scheduledFor: Date.now() + 300_000 }),
  ])
}

function cron(toolUseId: string, input: ToolInput): Promise<ToolInput> {
  return calls(toolUseId, 'CronCreate', input, () => [
    resultWith(toolUseId, 'Scheduled recurring job c4f1.', { id: 'c4f1', humanSchedule: 'Every day at 9:00 AM' }),
  ])
}

function bash(toolUseId: string, input: ToolInput, output = 'ok'): Promise<ToolInput> {
  return calls(toolUseId, 'Bash', input, () => [sdk.toolResult(toolUseId, output)])
}

/** What the `PostToolBatch` hook is told of a message's calls: each by its id, with the input the tool ran with. */
function batch(...entries: readonly (readonly [string, string, ToolInput?, string?])[]): BatchCall[] {
  return entries.map(([toolUseId, toolName, input = {}, output = '']) => ({ toolUseId, toolName, input, output }))
}

/** The agent's own calls in the tool log, by tool: each one's input, as logged. */
function logged(name: string): ToolInput[] {
  return listToolEvents(db, task.id)
    .filter((event): event is ToolCallEvent => event.kind === ToolEventKind.ToolCall && event.name === name)
    .map(({ input }) => input)
}

/** Each todo's children as `kind source`, sorted, then the ones under no todo. */
function placed(): string[][] {
  const { todos: groups, unfiled } = readTodoHub(db, task.id).children
  return [...groups, unfiled].map((group) =>
    group.children.map(({ kind, source }) => `${kind} ${source ?? 'unfiled'}`).sort(),
  )
}

/** The todo each of the task's subagents works on, by its call: plumbing, which no todo shows. */
function working(): Record<string, string> {
  return Object.fromEntries(subagentTodos(taskChildren(db, task.id)))
}

function filings(): string[] {
  return listFilings(db, task.id)
    .map(({ kind, key, todoId, source }) => `${kind} ${key} #${todoId} ${source}`)
    .sort()
}

/** Everything the hub shows that could carry a marker: the tool log, the watchers, and what was sent to the windows. */
function shown(): string {
  return JSON.stringify([listToolEvents(db, task.id), listWatchers(db, task.id), events])
}

function reply(): string | undefined {
  return listMessages(db, task.id)
    .filter(({ role }) => role === MessageRole.Agent)
    .at(-1)?.body
}

describe('a session that starts with the todo hub on', () => {
  it('has the hub’s hooks, its prompt lines and Claude Code’s task tools kept on', async () => {
    await say('Review the date helpers.')

    const { options } = session()
    expect(Object.keys(options.hooks ?? {}).sort()).toEqual([
      'onBashStarting',
      'onBatchFinished',
      'onChildStarting',
      'onCompacted',
      'onPrompt',
      'onTurnEnded',
      'onTurnEnding',
    ])
    expect(options.keepTaskTools).toBe(true)
    for (const line of TODO_HUB_LINES) expect(options.systemPromptAppend).toContain(line)
    // Its prompt says it all: nothing is sent ahead of its message, and it's recorded as told.
    expect(session().sent.map(({ text: sent }) => sent)).toEqual(['Review the date helpers.'])
    expect(getSessionContext(db, task.id)).toMatchObject({
      todoHub: true,
      instructionUpdates: INSTRUCTION_UPDATES.length,
    })
  })
})

describe('a call that names its todo', () => {
  beforeEach(async () => {
    await say('Review the date helpers, fix the UTC test, and watch CI on the PR.')
    await threeTodos()
  })

  it('records a subagent’s todo, and files the agent’s commit, where each call says, and the marker shows nowhere', async () => {
    runner.close()
    launch(committing({ toolu_commit: ['a', 'Fix the UTC date test'] }))
    await say('Review the date helpers and fix the UTC test.')
    await threeTodos()

    const reviewer = await subagent('toolu_agent', {
      description: '[todo 1] Review the date helpers',
      prompt: 'Review.',
    })
    const commit = { command: 'git commit -am "Fix"', description: '[todo 2] Commit the fix' }
    const committed = await bash('toolu_commit', commit, '[main aaaaaaa] Fix the UTC date test')

    // Each tool ran with its own text alone.
    expect(reviewer.description).toBe('Review the date helpers')
    expect(committed).toEqual({ command: commit.command, description: 'Commit the fix' })
    // The subagent's todo is recorded as it starts, and can be read back.
    expect(subagentTodo(taskChildren(db, task.id), 'toolu_agent')).toBe('1')
    // Nothing is left to ask, right after the calls or at the end of the turn.
    await expect(
      session().finishBatch(batch(['toolu_agent', 'Agent'], ['toolu_commit', 'Bash', { command: commit.command }])),
    ).resolves.toBeNull()
    await expect(session().tryToEnd()).resolves.toBeNull()
    expect(listOwedFilings(db, task.id)).toEqual([])

    expect(filings()).toEqual([`commit ${'a'.repeat(40)} /code/acme-api #2 named`, 'subagent toolu_agent #1 named'])
    expect(placed()).toEqual([[], ['commit named'], [], []])
    expect(working()).toEqual({ toolu_agent: '1' })
    // Nowhere: not the tool log's rows, nor anything the windows were sent.
    expect(shown()).not.toMatch(/\[todo/i)
    expect(logged('Agent')).toMatchObject([{ description: 'Review the date helpers' }])
    expect(logged('Bash')).toEqual([{ command: commit.command, description: 'Commit the fix' }])
  })

  it('leaves a watcher’s call exactly as it is, a marker in it included: nothing read, taken off, asked or held', async () => {
    const ci = { description: '[todo 3] CI checks on PR #42', command: 'gh pr checks 42' }
    const ran = [
      await monitor('toolu_ci', ci),
      await command('toolu_tests', { description: '[todo 2] Integration tests', command: 'npm test' }),
      await wakeup('toolu_wake', { delaySeconds: 300, reason: '[todo 3] Check CI again', prompt: 'Check.' }),
      await cron('toolu_cron', { cron: '0 9 * * *', prompt: '[todo 3] Check the PR.' }),
    ]

    // Each ran as the model wrote it, and is logged and labelled that way.
    expect(ran.map((input) => input.description ?? input.reason ?? input.prompt)).toEqual([
      '[todo 3] CI checks on PR #42',
      '[todo 2] Integration tests',
      '[todo 3] Check CI again',
      '[todo 3] Check the PR.',
    ])
    expect(logged('Monitor')).toEqual([ci])
    expect(listWatchers(db, task.id).map(({ label }) => label)).toEqual([
      '[todo 3] CI checks on PR #42',
      '[todo 2] Integration tests',
      '[todo 3] Check CI again',
      '[todo 3] Check the PR.',
    ])
    // Even put to Glade, as the SDK's hook never does, such a call gets nothing back in its place.
    await expect(
      session().startChild({ toolName: 'Monitor', input: ci, toolUseId: 'toolu_ci', agentId: null }),
    ).resolves.toBeNull()
    // No message after them, and no hold for them.
    await expect(
      session().finishBatch(
        batch(
          ['toolu_ci', 'Monitor', ci],
          ['toolu_tests', 'Bash', { command: 'npm test', run_in_background: true }],
          ['toolu_wake', 'ScheduleWakeup'],
          ['toolu_cron', 'CronCreate'],
        ),
      ),
    ).resolves.toBeNull()
    await expect(session().tryToEnd()).resolves.toBeNull()
    expect(filings()).toEqual([])
    expect(listOwedFilings(db, task.id)).toEqual([])
    expect(events.filter(({ type }) => type === EventType.FilingsChanged)).toEqual([])
  })

  it('is under its todo from the moment it exists: the windows hear the filing before the call’s row', async () => {
    events = []
    session().emit(sdk.toolUse('toolu_agent', 'Agent', { description: '[todo 2] Fix the test', prompt: 'Fix it.' }))
    await settle()

    const types = events.map((event) => event.type)
    expect(types.indexOf(EventType.FilingsChanged)).toBeGreaterThanOrEqual(0)
    expect(types.indexOf(EventType.FilingsChanged)).toBeLessThan(types.indexOf(EventType.ToolEventAppended))
    // The hook, a moment later, hands the tool its input without the marker, and files nothing twice.
    events = []
    await expect(
      session().startChild({
        toolName: 'Agent',
        input: { description: '[todo 2] Fix the test', prompt: 'Fix it.' },
        toolUseId: 'toolu_agent',
        agentId: null,
      }),
    ).resolves.toEqual({ description: 'Fix the test', prompt: 'Fix it.' })
    expect(events).toEqual([])
    expect(placed()).toEqual([[], [], [], []])
    expect(Object.values(working())).toEqual(['2'])
  })

  it('files three subagents started in one message under three todos', async () => {
    const descriptions = ['Review src/dates.js', 'Review src/users.js', 'Review src/orders.js']
    for (const [index, description] of descriptions.entries()) {
      await subagent(`toolu_${String(index + 1)}`, { description: `[todo ${String(index + 1)}] ${description}` })
    }

    await expect(
      session().finishBatch(batch(['toolu_1', 'Agent'], ['toolu_2', 'Agent'], ['toolu_3', 'Agent'])),
    ).resolves.toBeNull()
    expect(filings()).toEqual(['subagent toolu_1 #1 named', 'subagent toolu_2 #2 named', 'subagent toolu_3 #3 named'])
    expect(logged('Agent').map(({ description }) => description)).toEqual(descriptions)
  })

  it('takes a todo made by an earlier call of the same message, though its own call streamed first', async () => {
    // As the SDK streams a message: both calls' blocks, then the first one's result, then the hook for the second.
    session().emit(
      sdk.toolUse('toolu_create_4', 'TaskCreate', { subject: 'Review the order totals' }),
      sdk.toolUse('toolu_agent', 'Agent', { description: '[todo 4] Review the order totals' }),
    )
    await settle()
    // Streamed before the todo existed: not filed yet, and its row has no marker all the same.
    expect(filings()).toEqual([])
    expect(logged('Agent')).toEqual([{ description: 'Review the order totals' }])

    session().emit(sdk.toolResult('toolu_create_4', 'Task #4 created successfully: Review the order totals'))
    const handed = await session().startChild({
      toolName: 'Agent',
      input: { description: '[todo 4] Review the order totals' },
      toolUseId: 'toolu_agent',
      agentId: null,
    })

    expect(handed).toEqual({ description: 'Review the order totals' })
    expect(filings()).toEqual(['subagent toolu_agent #4 named'])
    await expect(
      session().finishBatch(batch(['toolu_create_4', 'TaskCreate'], ['toolu_agent', 'Agent'])),
    ).resolves.toBe(null)
  })

  it('still takes the marker off one that names a todo that is not there, and asks about it afterwards', async () => {
    const reviewer = await subagent('toolu_agent', { description: '[todo 9] Review the date helpers' })

    expect(reviewer.description).toBe('Review the date helpers')
    expect(filings()).toEqual([])
    expect(shown()).not.toMatch(/\[todo/i)
    const asked = await session().finishBatch(batch(['toolu_agent', 'Agent']))
    expect(asked).toContain('- c1: subagent "Review the date helpers"')
    expect(placed()).toEqual([[], [], [], []])
    expect(working()).toEqual({})
  })
})

describe('a subagent’s own calls', () => {
  it('are never asked about: its commits follow its todo, and a subagent it starts works on it unless it names another', async () => {
    runner.close()
    launch(
      committing({
        toolu_commit: ['a', 'Fix the UTC date test'],
        toolu_sub_commit: ['b', 'Fix the date tests'],
        toolu_other_commit: ['c', 'Fix the CI config'],
      }),
    )
    await say('Review the date helpers and fix the UTC test.')
    await threeTodos()

    await subagent('toolu_agent', { description: '[todo 1] Review the date helpers' })
    // The subagent's own: a command it leaves running, written with a marker of its own, a subagent it starts naming
    // no todo, and one it starts naming another.
    session().emit(
      sdk.toolUse(
        'toolu_sub_tests',
        'Bash',
        { command: 'npm test -- --watch', description: '[todo 2] Date tests', run_in_background: true },
        'toolu_agent',
      ),
      { ...(taskStarted('toolu_sub_tests', 'b_sub', '[todo 2] Date tests') as object), owned_by_subagent: true },
      sdk.toolResult('toolu_sub_tests', 'Command running in background.', false, 'toolu_agent'),
      sdk.toolUse('toolu_nested', 'Agent', { description: 'Check the fixtures' }, 'toolu_agent', 'msg_02'),
      sdk.toolResult('toolu_nested', 'The fixtures are fine.', false, 'toolu_agent'),
      sdk.toolUse('toolu_other', 'Agent', { description: '[todo 3] Check CI' }, 'toolu_agent', 'msg_03'),
    )
    await settle()
    // The SDK's hook for a subagent's `Agent` call carries the subagent's id: the marker comes off for it too.
    await expect(
      session().startChild({
        toolName: 'Agent',
        input: { description: '[todo 3] Check CI' },
        toolUseId: 'toolu_other',
        agentId: 'a_toolu_agent',
      }),
    ).resolves.toEqual({ description: 'Check CI' })
    // Each of them commits; the first subagent's command is written with a marker, which is its own.
    session().emit(
      sdk.toolUse('toolu_other_commit', 'Bash', { command: 'git commit -am "CI"' }, 'toolu_other', 'msg_04'),
      sdk.toolResult('toolu_other_commit', '[main ccccccc] Fix the CI config', false, 'toolu_other'),
      sdk.toolResult('toolu_other', 'CI is green.', false, 'toolu_agent'),
      sdk.toolUse(
        'toolu_sub_commit',
        'Bash',
        { command: 'git commit -am "Fix"', description: '[todo 2] Commit' },
        'toolu_agent',
        'msg_05',
      ),
      sdk.toolResult('toolu_sub_commit', '[main bbbbbbb] Fix the date tests', false, 'toolu_agent'),
    )
    await settle()
    // The agent commits too, naming another todo.
    await bash('toolu_commit', { command: 'git commit -am "Fix"', description: '[todo 2] Commit the fix' })

    await expect(
      session().finishBatch(batch(['toolu_agent', 'Agent'], ['toolu_commit', 'Bash', { command: 'git commit' }])),
    ).resolves.toBeNull()
    await expect(session().tryToEnd()).resolves.toBeNull()

    // What's recorded: the agent's commit, its subagent's todo, and the todo the nested subagent named.
    expect(filings()).toEqual([
      `commit ${'a'.repeat(40)} /code/acme-api #2 named`,
      'subagent toolu_agent #1 named',
      'subagent toolu_other #3 named',
    ])
    const children = taskChildren(db, task.id)
    expect(subagentTodo(children, 'toolu_nested')).toBe('1')
    expect(subagentTodo(children, 'toolu_other')).toBe('3')
    // Each subagent's commit is under the todo it works on, with nothing asked.
    expect(placed()).toEqual([['commit inherited'], ['commit named'], ['commit inherited'], []])
    // The marker is off every `Agent` call's row, a subagent's too.
    expect(logged('Agent').map(({ description }) => description)).toEqual([
      'Review the date helpers',
      'Check the fixtures',
      'Check CI',
    ])
    // A subagent's commands are logged, and its watcher labelled, as it wrote them.
    expect(logged('Bash')).toContainEqual({
      command: 'npm test -- --watch',
      description: '[todo 2] Date tests',
      run_in_background: true,
    })
    expect(logged('Bash')).toContainEqual({ command: 'git commit -am "Fix"', description: '[todo 2] Commit' })
    expect(listWatchers(db, task.id).map(({ label }) => label)).toEqual(['[todo 2] Date tests'])
    expect(listOwedFilings(db, task.id)).toEqual([])
  })
})

describe('a call that names no todo', () => {
  beforeEach(async () => {
    await say('Review the order totals, note the review, and watch the staging deploy.')
    await threeTodos()
  })

  it('goes ahead as written, and the agent is told of what its message made at once, and files it in one call', async () => {
    runner.close()
    launch(committing({ toolu_commit: ['a', 'Note the date review'] }))
    await say('Review the order totals, note the review, and watch the staging deploy.')
    await threeTodos()
    // One message: a subagent and a commit, neither naming a todo, and a watcher of each kind.
    await subagent('toolu_agent', { description: 'Review the order totals' })
    await bash('toolu_commit', { command: 'git commit -am "Note"', description: 'Commit the note' })
    await monitor('toolu_deploy', { description: 'Deploy to staging', command: './deploy-status.sh' })
    await command('toolu_docs', { description: 'Build the docs site', command: 'npm run build:docs' })
    await wakeup('toolu_wake', { delaySeconds: 300, reason: 'Check the deploy', prompt: 'Check it.' })
    await cron('toolu_cron', { cron: '30 9 * * *', prompt: 'Check the staging queue depth.' })
    expect(filings()).toEqual([])

    const asked = await session().finishBatch(
      batch(
        ['toolu_agent', 'Agent'],
        ['toolu_commit', 'Bash', { command: 'git commit -am "Note"' }],
        ['toolu_deploy', 'Monitor'],
        ['toolu_docs', 'Bash', { command: 'npm run build:docs', run_in_background: true }],
        ['toolu_wake', 'ScheduleWakeup'],
        ['toolu_cron', 'CronCreate'],
        // The message's other calls are none of the hub's business.
        ['toolu_read', 'Read', { file_path: 'README.md' }, '# Acme API'],
      ),
    )

    // The subagent and the commit, and nothing of the watchers.
    expect(asked).toBe(
      [
        `Glade: file what you just made under its todo now, before your next step, with one ${FILE_CHILDREN_TOOL} call.`,
        'Made:',
        '- c1: subagent "Review the order totals"',
        '- c2: commit "aaaaaaa Note the date review"',
        'Your todos: #1 Review the date helpers (pending) · #2 Fix the UTC date test (pending) · ' +
          '#3 Watch CI on PR #42 (pending)',
        'If no todo fits, create it first with TaskCreate.',
      ].join('\n'),
    )
    await session().callTool('toolu_file', FILE_CHILDREN_TOOL, {
      filings: [
        { child: 'c1', todo: '1' },
        { child: 'c2', todo: '2' },
      ],
    })
    await settle()

    // The commit is where the agent filed it; its four watchers are under nothing.
    expect(placed()).toEqual([[], ['commit asked'], [], []])
    expect(subagentTodo(taskChildren(db, task.id), 'toolu_agent')).toBe('1')
    // Its filing call is a message like any other, with nothing to file, and the turn ends unheld: no watcher holds it.
    await expect(session().finishBatch(batch(['toolu_file', FILE_CHILDREN_TOOL]))).resolves.toBeNull()
    await expect(session().tryToEnd()).resolves.toBeNull()
    session().emit(
      sdk.text('The order totals are reviewed.', null, 'msg_09'),
      sdk.result('The order totals are reviewed.'),
    )
    await settle()
    expect(reply()).toBe('The order totals are reviewed.')
  })

  it('is told of a commit Glade finds after an unnamed Bash call, waiting for git first', async () => {
    let found: () => void = () => undefined
    const finding = new Promise<void>((resolve) => {
      found = resolve
    })
    runner.close()
    launch({
      bashStarting: () => Promise.resolve(),
      // Git is read once the call's result is in, which takes a moment.
      bashFinished: async (taskId, { toolUseId }) => {
        await finding
        if (listTaskCommits(db, taskId).length > 0) return
        addTaskCommit(db, {
          taskId,
          gitDir: '/code/acme-api/.git',
          repoPath: '/code/acme-api',
          hash: 'c'.repeat(40),
          subject: 'Note the date review',
          branch: 'main',
          committedAt: 5_000,
          additions: 1,
          deletions: 0,
          filesChanged: 1,
          parents: 1,
          toolUseId,
          source: CommitSource.Printed,
        })
      },
      sessionEnded: () => undefined,
    })
    await say('Note the review and commit it.')
    await threeTodos()
    await bash(
      'toolu_commit',
      { command: 'git commit -am "Note"', description: 'Commit the note' },
      '[main ccccccc] Note',
    )

    const asking = session().finishBatch(
      batch(['toolu_commit', 'Bash', { command: 'git commit -am "Note"' }, '[main ccccccc] Note']),
    )
    let asked: string | null | undefined
    void asking.then((answer) => {
      asked = answer
    })
    await settle()
    // The hook holds the agent's next step until the commit is known.
    expect(asked).toBeUndefined()
    found()

    await expect(asking).resolves.toContain('- c1: commit "ccccccc Note the date review"')
    expect(listOwedFilings(db, task.id)).toHaveLength(1)
  })

  it('holds the end of the turn twice when the agent ignores it, then lets the turn end, and asks again next turn', async () => {
    await subagent('toolu_agent', { description: 'Review the order totals' })
    await expect(session().finishBatch(batch(['toolu_agent', 'Agent']))).resolves.toContain('Made:')
    const hold = [
      `Glade: these aren't filed under a todo yet. File them with one ${FILE_CHILDREN_TOOL} call, then end your turn.`,
      '- c1: subagent "Review the order totals"',
      'Your todos: #1 Review the date helpers (pending) · #2 Fix the UTC date test (pending) · ' +
        '#3 Watch CI on PR #42 (pending)',
    ].join('\n')

    // The agent ignores Glade's message, and replies.
    session().emit(sdk.text('The totals are being reviewed.', null, 'msg_02'))
    await expect(session().tryToEnd()).resolves.toBe(hold)
    // Held, it only writes its reply again, twice.
    session().emit(sdk.text('The totals are being reviewed, as I said.', null, 'msg_03'))
    await expect(session().tryToEnd(true)).resolves.toBe(hold)
    session().emit(sdk.text('The order totals are under review.', null, 'msg_04'))
    // Held twice: the turn ends.
    await expect(session().tryToEnd(true)).resolves.toBeNull()
    session().emit(sdk.result('The order totals are under review.'))
    await settle()

    // The user reads its last reply alone; the ones it wrote before each hold are in the tool log.
    expect(reply()).toBe('The order totals are under review.')
    const narrated = listToolEvents(db, task.id).flatMap((event) =>
      event.kind === ToolEventKind.Narration ? [event.text] : [],
    )
    expect(narrated).toEqual(['The totals are being reviewed.', 'The totals are being reviewed, as I said.'])
    expect(getTask(db, task.id)?.activity).toBe('waiting')
    // What's left stays under "Not under a todo", and is still owed.
    expect(placed()).toEqual([[], [], [], []])
    expect(working()).toEqual({})
    expect(listOwedFilings(db, task.id)).toHaveLength(1)

    // The end of its next turn asks again, and this time it files.
    await say('Thanks. Anything else?')
    session().emit(sdk.text('Nothing else.', null, 'msg_05'))
    await expect(session().tryToEnd()).resolves.toBe(hold)
    await session().callTool('toolu_file', FILE_CHILDREN_TOOL, { filings: [{ child: 'c1', todo: '3' }] })
    session().emit(sdk.text('Nothing else.', null, 'msg_06'))
    await expect(session().tryToEnd(true)).resolves.toBeNull()
    session().emit(sdk.result('Nothing else.'))
    await settle()
    expect(working()).toEqual({ toolu_agent: '3' })
    expect(reply()).toBe('Nothing else.')
  })

  it('keeps the reply written before a hold as the turn’s, when the agent files and writes nothing more', async () => {
    await subagent('toolu_agent', { description: 'Review the order totals' })
    await session().finishBatch(batch(['toolu_agent', 'Agent']))
    session().emit(sdk.text('The totals are being reviewed.', null, 'msg_02'))
    await expect(session().tryToEnd()).resolves.toContain('- c1: subagent "Review the order totals"')

    // Held, it files, and ends its turn there, with no reply of its own after the call.
    await session().callTool('toolu_file', FILE_CHILDREN_TOOL, { filings: [{ child: 'c1', todo: '3' }] })
    await expect(session().tryToEnd(true)).resolves.toBeNull()
    session().emit(sdk.result(''))
    await settle()

    expect(reply()).toBe('The totals are being reviewed.')
    expect(working()).toEqual({ toolu_agent: '3' })
  })

  it('never holds a turn you stopped, and takes in what its unfinished message made at the end of the next', async () => {
    await subagent('toolu_agent', { description: 'Review the order totals' })
    // You press Stop before the message's calls have all run: nothing tells the agent, and the turn isn't held.
    const stopped = runner.stop(task.id)
    await expect(session().tryToEnd()).resolves.toBeNull()
    session().emit(sdk.interruptMarker(), sdk.abortedResult())
    await stopped
    expect(listOwedFilings(db, task.id)).toEqual([])

    await say('Carry on.')
    session().emit(sdk.text('Carrying on.', null, 'msg_02'))

    await expect(session().tryToEnd()).resolves.toContain('- c1: subagent "Review the order totals"')
  })

  it('never holds a compaction, which is no turn of the agent’s', async () => {
    await subagent('toolu_agent', { description: 'Review the order totals' })
    await session().finishBatch(batch(['toolu_agent', 'Agent']))
    session().emit(sdk.text('Reviewing the totals.', null, 'msg_02'))
    await session().tryToEnd()
    await session().tryToEnd(true)
    await expect(session().tryToEnd(true)).resolves.toBeNull()
    session().emit(sdk.result('Reviewing the totals.'))
    await settle()

    runner.compact(task.id)
    expect(session().sent.at(-1)?.text).toBe(COMPACT_COMMAND)
    session().emit(sdk.init(), ...sdk.compaction(60_000, 12_000))

    await expect(session().tryToEnd()).resolves.toBeNull()
    session().emit(sdk.compactResult())
    await settle()
    expect(listOwedFilings(db, task.id)).toHaveLength(1)
  })

  it('tells an agent with no todo list to create a todo first', async () => {
    runner.close()
    task = sampleTask(db, task.workspaceId)
    launch()
    await say('Review the order totals.')
    await subagent('toolu_agent', { description: 'Review the order totals' })

    const asked = await session().finishBatch(batch(['toolu_agent', 'Agent']))

    expect(asked?.split('\n').at(-1)).toBe(NO_TODOS)
    await expect(session().tryToEnd()).resolves.toContain(NO_TODOS)
  })
})

describe('a session that is closing', () => {
  it('leaves its calls and its turn’s end as they are', async () => {
    await say('Review the order totals.')
    await threeTodos()
    await subagent('toolu_agent', { description: 'Review the order totals' })
    const closing = session()

    runner.close()

    await expect(
      closing.startChild({
        toolName: 'Agent',
        input: { description: '[todo 1] Review' },
        toolUseId: 'toolu_late',
        agentId: null,
      }),
    ).resolves.toBeNull()
    await expect(closing.finishBatch(batch(['toolu_agent', 'Agent']))).resolves.toBeNull()
    await expect(closing.tryToEnd()).resolves.toBeNull()
    expect(listFilings(db, task.id)).toEqual([])
    expect(listOwedFilings(db, task.id)).toEqual([])
    launch()
  })

  it('asks nothing when it closes while git is read for a message’s commits', async () => {
    let read: () => void = () => undefined
    const reading = new Promise<void>((resolve) => {
      read = resolve
    })
    runner.close()
    launch({ bashStarting: () => Promise.resolve(), bashFinished: () => reading, sessionEnded: () => undefined })
    await say('Commit the note.')
    await bash('toolu_commit', { command: 'git commit -am "Note"', description: 'Commit the note' })
    const closing = session()
    const asking = closing.finishBatch(batch(['toolu_commit', 'Bash', { command: 'git commit -am "Note"' }]))
    await settle()

    runner.close()
    read()

    await expect(asking).resolves.toBeNull()
    launch()
  })
})

describe('a commit by a call that names its todo, found by git', () => {
  let repos: TestRepos

  beforeEach(() => {
    repos = openTestRepos()
  })

  afterEach(() => {
    repos.close()
  })

  it('is filed as it’s found: the windows hear its filing before they hear of the commit', async () => {
    const api = repos.repo('acme-api', { 'src/date.ts': 'export const header = 1\n' })
    runner.close()
    task = sampleTask(db, sampleWorkspace(db, api).id)
    // The runner's own tracker, reading real git.
    launch(null)
    await say('Fix the UTC test and commit it.')
    session().emit(...todos('Fix the UTC date test'))
    await settle()
    const input = { command: 'git commit -am "Fix the UTC date test"', description: '[todo 1] Commit the fix' }
    events = []

    session().emit(sdk.toolUse('toolu_commit', 'Bash', input))
    await session().startBash({ toolUseId: 'toolu_commit', cwd: api, command: input.command })
    await expect(
      session().startChild({ toolName: 'Bash', input, toolUseId: 'toolu_commit', agentId: null }),
    ).resolves.toEqual({ command: input.command, description: 'Commit the fix' })
    repos.write('acme-api/src/date.ts', 'export const header = 2\n')
    const output = repos.sh(`${input.command} 2>&1`, api)
    session().emit(sdk.toolResult('toolu_commit', output))
    await expect(
      session().finishBatch(batch(['toolu_commit', 'Bash', { command: input.command }, output])),
    ).resolves.toBeNull()

    expect(listTaskCommits(db, task.id).map(({ subject }) => subject)).toEqual(['Fix the UTC date test'])
    expect(placed()).toEqual([['commit named'], []])
    const types = events.map((event) => event.type)
    expect(types.filter((type) => type === EventType.CommitsChanged)).toHaveLength(1)
    expect(types.indexOf(EventType.FilingsChanged)).toBeLessThan(types.indexOf(EventType.CommitsChanged))
    expect(logged('Bash')).toEqual([{ command: input.command, description: 'Commit the fix' }])
  })
})

describe('the todo hub turned on while a task has a session', () => {
  beforeEach(() => {
    runner.close()
    updateSettings(db, { todoHubEnabled: false })
    launch()
  })

  it('leaves the live session as it started, and the session that resumes gets the hub and its lines, once', async () => {
    await say('Review the date helpers.')
    const before = session()
    expect(Object.keys(before.options.hooks ?? {}).sort()).toEqual([
      'onBashStarting',
      'onCompacted',
      'onPrompt',
      'onTurnEnded',
    ])
    before.emit(...todos('Review the date helpers'), sdk.text('On it.', null, 'msg_02'), sdk.result('On it.'))
    await settle()
    const recorded = getSessionContext(db, task.id)
    expect(recorded).toMatchObject({ todoHub: false, instructionUpdates: INSTRUCTION_UPDATES.length })

    // The switch is turned on mid-task. The session that's running keeps the tools, prompt and hooks it started
    // with: nothing is sent to it, a marker is left where it is, and nothing is asked or held.
    updateSettings(db, { todoHubEnabled: true })
    await say('And the order totals.')
    expect(backend.sessions).toHaveLength(1)
    expect(before.sent.at(-1)?.text).toBe('And the order totals.')
    await subagent('toolu_old', { description: '[todo 1] Review the order totals' })
    await expect(before.finishBatch(batch(['toolu_old', 'Agent']))).resolves.toBeNull()
    await expect(before.tryToEnd()).resolves.toBeNull()
    before.emit(sdk.text('Reviewing.', null, 'msg_03'), sdk.result('Reviewing.'))
    await settle()
    expect(logged('Agent')).toMatchObject([{ description: '[todo 1] Review the order totals' }])
    expect(listFilings(db, task.id)).toEqual([])
    expect(getSessionContext(db, task.id)).toEqual(recorded)

    // Relaunched, the task's session resumes with the hub: its tools, its hooks, and, since Claude Code keeps the
    // prompt the session started with, the hub's lines ahead of its next message.
    runner.close()
    launch()
    await say('How is the review?')
    const resumed = session()
    expect(resumed.options.resumeSessionId).toBe(sdk.SESSION_ID)
    expect(Object.keys(resumed.options.hooks ?? {})).toContain('onChildStarting')
    expect(resumed.options.keepTaskTools).toBe(true)
    expect(resumed.sent.map(({ text: sent }) => sent)).toEqual([
      `[Glade: this session now files what it makes under its todos]\n${TODO_HUB_LINES.join('\n\n')}\n[end]\n\nHow is the review?`,
    ])
    // The chat keeps only what you wrote.
    expect(listMessages(db, task.id).at(-1)?.body).toBe('How is the review?')
    // Recorded as told, apart from the count of instructions it has had, which is what it was.
    expect(getSessionContext(db, task.id)).toEqual({ ...recorded, todoHub: true })

    // It files from here on, as a session that started with the hub does.
    await subagent('toolu_new', { description: '[todo 1] Review the date helpers again' })
    expect(filings()).toEqual(['subagent toolu_new #1 named'])
    expect(logged('Agent').at(-1)).toMatchObject({ description: 'Review the date helpers again' })
    resumed.emit(sdk.text('CI is green.', null, 'msg_04'), sdk.result('CI is green.'))
    await settle()

    // Told once: not with its next message, nor after another relaunch.
    await say('Thanks.')
    expect(resumed.sent.at(-1)?.text).toBe('Thanks.')
    resumed.emit(sdk.text('Any time.', null, 'msg_05'), sdk.result('Any time.'))
    await settle()
    runner.close()
    launch()
    await say('One more thing.')
    expect(session().sent.map(({ text: sent }) => sent)).toEqual(['One more thing.'])
    // What the old session made, before the hub was its own, is nobody's to ask about.
    await expect(session().tryToEnd()).resolves.toBeNull()
    expect(placed()).toEqual([[], []])
    expect(Object.values(working())).toEqual(['1'])
  })

  it('sends a session that started elsewhere Glade’s whole prompt, hub and all, and records it as told', async () => {
    db.prepare('UPDATE tasks SET session_id = ?, imported_at = 1 WHERE id = ?').run(sdk.SESSION_ID, task.id)
    updateSettings(db, { todoHubEnabled: true })
    runner.close()
    launch()

    await say('Carry on.')

    const [sent] = session().sent
    expect(sent?.text).toMatch(/^\[Glade: instructions for this session\]/)
    for (const line of TODO_HUB_LINES) expect(sent?.text).toContain(line)
    expect(sent?.text).not.toContain('[Glade: this session now files')
    expect(getSessionContext(db, task.id)).toMatchObject({ instructions: true, todoHub: true })
  })
})
