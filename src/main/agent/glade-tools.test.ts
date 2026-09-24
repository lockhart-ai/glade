import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventType, type GladeEvent } from '../../shared/bridge'
import {
  QuestionKind,
  QuestionReplyKind,
  QuestionSetState,
  TaskActivity,
  type Question,
  type QuestionSet,
  type Task,
} from '../../shared/domain'
import { listArtifacts } from '../db/repositories/artifacts'
import { getOpenFiles } from '../db/repositories/open-files'
import { getOpenQuestionSet, listQuestionSets } from '../db/repositories/question-sets'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { createQuestionBroker } from '../questions/questions'
import {
  createGladeMcpServer,
  createGladeToolHandlers,
  GLADE_SERVER,
  GladeTool,
  QUESTIONS_WITHDRAWN,
  type GladeToolContext,
} from './glade-tools'
import { createMcpToolCaller, type McpToolCaller } from './mcp-tool-caller'

let database: TestDatabase
let task: Task
let events: GladeEvent[]
let context: GladeToolContext
let caller: McpToolCaller

beforeEach(() => {
  database = openTestDatabase()
  task = sampleTask(database.db, sampleWorkspace(database.db).id)
  events = []
  const base = { db: database.db, emit: (event: GladeEvent) => events.push(event) }
  context = { ...base, questions: createQuestionBroker(base) }
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
      GladeTool.Ask,
      GladeTool.ShowFile,
      GladeTool.AddArtifact,
    ])
    for (const listed of tools) expect(listed._meta).toEqual({ 'anthropic/alwaysLoad': true })
    expect(tools.map((listed) => listed.inputSchema.required)).toEqual([
      ['title'],
      ['objective'],
      ['status'],
      ['questions'],
      ['path'],
      ['path', 'title'],
    ])
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

describe('ask', () => {
  const QUESTIONS: Question[] = [
    {
      kind: QuestionKind.Choice,
      prompt: 'How should the notes be laid out?',
      options: [
        { id: 'by-type', label: 'By type', detail: 'Features, fixes, internal.', sketch: '## Features\n- …' },
        { id: 'by-area', label: 'By area' },
      ],
    },
    { kind: QuestionKind.Pills, prompt: 'Credit contributors?', options: ['GitHub handles', 'No credits'] },
    { kind: QuestionKind.Text, prompt: 'Anything else?', placeholder: 'e.g. a known issue', optional: true },
  ]

  /** Calls `ask` over MCP, and resolves once its questions are open. */
  async function ask(input: Record<string, unknown>, signal?: AbortSignal) {
    const outcome = caller.call('mcp__glade__ask', input, signal)
    const open = await vi.waitFor(() => {
      const set = getOpenQuestionSet(database.db, task.id)
      if (set === undefined) throw new Error('No question is open yet')
      return set
    })
    return { outcome, open }
  }

  /** The question events since the last call, as each one's type and the set's state. */
  function drainQuestionEvents(): unknown[] {
    return events.splice(0).flatMap((event) => ('questionSet' in event ? [[event.type, event.questionSet.state]] : []))
  }

  it('opens the questions, blocks until they are answered, and returns the answers keyed by question index', async () => {
    const { outcome, open } = await ask({ questions: QUESTIONS })

    expect(open).toMatchObject({ taskId: task.id, turn: 1, questions: QUESTIONS, state: QuestionSetState.Open })
    expect(current()).toMatchObject({ asking: true, activity: TaskActivity.Waiting })
    expect(drainQuestionEvents()).toEqual([[EventType.QuestionOpened, QuestionSetState.Open]])
    let returned = false
    void outcome.then(() => {
      returned = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(returned).toBe(false)

    const answers = { 0: 'by-type', 1: 'No credits' }
    context.questions.answer(open.id, { kind: QuestionReplyKind.Answers, answers })

    await expect(outcome).resolves.toEqual({ output: '{"0":"by-type","1":"No credits"}', isError: false })
    expect(current()).toMatchObject({ asking: false, activity: TaskActivity.Working })
    expect(drainQuestionEvents()).toEqual([[EventType.QuestionAnswered, QuestionSetState.Answered]])
  })

  it('returns an answer in words as free text', async () => {
    const { outcome, open } = await ask({ questions: QUESTIONS })

    context.questions.answer(open.id, { kind: QuestionReplyKind.FreeText, text: 'By type, and no credits.' })

    await expect(outcome).resolves.toEqual({ output: '{"freeText":"By type, and no credits."}', isError: false })
  })

  it('tells the model when the questions are withdrawn', async () => {
    const { outcome } = await ask({ questions: QUESTIONS })

    context.questions.withdraw(task.id)

    await expect(outcome).resolves.toEqual({ output: QUESTIONS_WITHDRAWN, isError: true })
    expect(current().asking).toBe(false)
    expect(listQuestionSets(database.db, task.id).map(({ state }) => state)).toEqual([QuestionSetState.Withdrawn])
  })

  it('withdraws the questions when the SDK cancels the call', async () => {
    const cancel = new AbortController()
    const { outcome } = await ask({ questions: QUESTIONS }, cancel.signal)

    cancel.abort()

    await expect(outcome).rejects.toThrow()
    await vi.waitFor(() => {
      expect(listQuestionSets(database.db, task.id).map(({ state }) => state)).toEqual([QuestionSetState.Withdrawn])
    })
    expect(current().asking).toBe(false)
  })

  it('withdraws the questions at once for a call cancelled before it ran', async () => {
    const handlers = createGladeToolHandlers(context, task.id)

    const outcome = await handlers.ask({ questions: QUESTIONS }, AbortSignal.abort())

    expect(outcome).toEqual({ content: [{ type: 'text', text: QUESTIONS_WITHDRAWN }], isError: true })
    expect(listQuestionSets(database.db, task.id).map(({ state }) => state)).toEqual([QuestionSetState.Withdrawn])
  })

  it('refuses questions that are not well formed, and opens nothing', async () => {
    const choice = QUESTIONS[0]
    const inputs: Record<string, unknown>[] = [
      {},
      { questions: [] },
      { questions: [{ kind: 'slider', prompt: 'How much?' }] },
      { questions: [{ kind: QuestionKind.Text, prompt: '  ' }] },
      { questions: [{ kind: QuestionKind.Pills, prompt: 'Credit?', options: ['Yes'] }] },
      { questions: [{ kind: QuestionKind.Pills, prompt: 'Credit?', options: ['Yes', 'Yes'] }] },
      { questions: [{ ...choice, options: [{ id: 'a', label: 'A' }] }] },
      {
        questions: [
          {
            ...choice,
            options: [
              { id: 'a', label: 'A' },
              { id: 'a', label: 'B' },
            ],
          },
        ],
      },
      { questions: [{ kind: QuestionKind.Choice, prompt: 'Which?', options: [{ id: 'a' }, { id: 'b' }] }] },
    ]
    for (const input of inputs) {
      const outcome = await caller.call('mcp__glade__ask', input)
      expect(outcome.isError).toBe(true)
    }

    expect(listQuestionSets(database.db, task.id)).toEqual([])
    expect(events).toEqual([])
  })

  it('stores the questions as the model sent them, trimmed', async () => {
    const { outcome, open } = await ask({
      questions: [{ kind: QuestionKind.Pills, prompt: ' Credit contributors? ', options: [' Yes', 'No '] }],
    })

    expect(open.questions).toEqual<QuestionSet['questions']>([
      { kind: QuestionKind.Pills, prompt: 'Credit contributors?', options: ['Yes', 'No'] },
    ])
    context.questions.withdraw(task.id)
    await outcome
  })
})

describe('show_file', () => {
  let root: string
  let showing: McpToolCaller
  let taskId: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'glade-show-file-'))
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs', 'rate-limits.md'), '# Rate limits\n')
    taskId = sampleTask(database.db, sampleWorkspace(database.db, root).id).id
    showing = createMcpToolCaller({ [GLADE_SERVER]: createGladeMcpServer(context, taskId) })
  })

  afterEach(async () => {
    await showing.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('opens the file in the task’s Files tab and asks the window to show it, at the line if given', async () => {
    await expect(showing.call('mcp__glade__show_file', { path: 'docs/rate-limits.md', line: 8 })).resolves.toEqual({
      output: 'Showing docs/rate-limits.md at line 8.',
      isError: false,
    })
    await expect(
      showing.call('mcp__glade__show_file', { path: join(root, 'docs', 'rate-limits.md') }),
    ).resolves.toEqual({ output: 'Showing docs/rate-limits.md.', isError: false })

    expect(getOpenFiles(database.db, taskId)).toEqual({
      taskId,
      paths: ['docs/rate-limits.md'],
      activePath: 'docs/rate-limits.md',
    })
    expect(events.filter((event) => event.type === EventType.FileShown)).toEqual([
      { type: EventType.FileShown, taskId, path: 'docs/rate-limits.md', line: 8 },
      { type: EventType.FileShown, taskId, path: 'docs/rate-limits.md', line: null },
    ])
  })

  it('answers with a tool error for a file it can’t show, or input that isn’t valid, and opens nothing', async () => {
    const missing = await showing.call('mcp__glade__show_file', { path: 'docs/gone.md' })
    expect(missing).toEqual({ output: "There's no file at docs/gone.md.", isError: true })
    const outside = await showing.call('mcp__glade__show_file', { path: '/etc/hosts' })
    expect(outside.isError).toBe(true)
    expect(outside.output).toContain('is outside the workspace')
    for (const input of [{}, { path: '  ' }, { path: 'docs/rate-limits.md', line: 0 }, { path: 'x', line: 1.5 }]) {
      expect((await showing.call('mcp__glade__show_file', input)).isError).toBe(true)
    }

    expect(getOpenFiles(database.db, taskId).paths).toEqual([])
    expect(events).toEqual([])
  })
})

describe('add_artifact', () => {
  let root: string
  let adding: McpToolCaller
  let taskId: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'glade-add-artifact-'))
    mkdirSync(join(root, 'docs', 'releases'), { recursive: true })
    writeFileSync(join(root, 'docs', 'releases', '2.4.md'), '# Release notes 2.4\n')
    writeFileSync(join(root, 'docs', 'releases', '2.4-upgrade.md'), '# Upgrading to 2.4\n')
    taskId = sampleTask(database.db, sampleWorkspace(database.db, root).id).id
    adding = createMcpToolCaller({ [GLADE_SERVER]: createGladeMcpServer(context, taskId) })
  })

  afterEach(async () => {
    await adding.close()
    rmSync(root, { recursive: true, force: true })
  })

  const changes = (): (readonly string[])[] =>
    events.flatMap((event) =>
      event.type === EventType.ArtifactsChanged && event.taskId === taskId
        ? [event.artifacts.map(({ path, title }) => `${path}: ${title}`)]
        : [],
    )

  it('declares a file of the workspace, by a relative or absolute path, and broadcasts the list', async () => {
    await expect(
      adding.call('mcp__glade__add_artifact', { path: 'docs/releases/2.4.md', title: 'Release notes 2.4' }),
    ).resolves.toEqual({
      output: 'Added docs/releases/2.4.md to the artifacts as "Release notes 2.4".',
      isError: false,
    })
    await adding.call('mcp__glade__add_artifact', {
      path: join(root, 'docs', 'releases', '2.4-upgrade.md'),
      title: 'Upgrade guide',
    })

    expect(listArtifacts(database.db, taskId).map(({ path, title }) => [path, title])).toEqual([
      ['docs/releases/2.4.md', 'Release notes 2.4'],
      ['docs/releases/2.4-upgrade.md', 'Upgrade guide'],
    ])
    expect(changes()).toEqual([
      ['docs/releases/2.4.md: Release notes 2.4'],
      ['docs/releases/2.4.md: Release notes 2.4', 'docs/releases/2.4-upgrade.md: Upgrade guide'],
    ])
  })

  it('renames an artifact declared again, keeping one per path', async () => {
    vi.useFakeTimers({ now: 1_000, toFake: ['Date'] })
    await adding.call('mcp__glade__add_artifact', { path: 'docs/releases/2.4.md', title: 'Release notes' })
    vi.setSystemTime(2_000)

    await expect(
      adding.call('mcp__glade__add_artifact', { path: './docs/releases/2.4.md', title: 'Release notes 2.4' }),
    ).resolves.toEqual({ output: 'Renamed the artifact docs/releases/2.4.md to "Release notes 2.4".', isError: false })

    expect(listArtifacts(database.db, taskId)).toEqual([
      { taskId, path: 'docs/releases/2.4.md', title: 'Release notes 2.4', addedAt: 1_000, updatedAt: 2_000 },
    ])
    expect(changes().at(-1)).toEqual(['docs/releases/2.4.md: Release notes 2.4'])
    vi.useRealTimers()
  })

  it('answers with a tool error for a path outside the workspace, no file, or input that isn’t valid', async () => {
    const outside = await adding.call('mcp__glade__add_artifact', { path: '/etc/hosts', title: 'Hosts' })
    expect(outside.isError).toBe(true)
    expect(outside.output).toContain('is outside the workspace')
    await expect(
      adding.call('mcp__glade__add_artifact', { path: '../secrets.txt', title: 'Secrets' }),
    ).resolves.toMatchObject({ isError: true })
    await expect(adding.call('mcp__glade__add_artifact', { path: 'docs/gone.md', title: 'Gone' })).resolves.toEqual({
      output: "There's no file at docs/gone.md.",
      isError: true,
    })
    await expect(adding.call('mcp__glade__add_artifact', { path: 'docs', title: 'A folder' })).resolves.toMatchObject({
      isError: true,
    })
    for (const input of [{}, { path: 'docs/releases/2.4.md' }, { path: 'docs/releases/2.4.md', title: ' ' }]) {
      expect((await adding.call('mcp__glade__add_artifact', input)).isError).toBe(true)
    }

    expect(listArtifacts(database.db, taskId)).toEqual([])
    expect(changes()).toEqual([])
  })
})
