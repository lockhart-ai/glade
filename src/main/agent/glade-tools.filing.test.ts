/**
 * `add_artifact`'s todo (P16-04, #495): in a session with the todo hub on, the tool takes the id of the todo an
 * artifact belongs under, and needs it, and `update_artifact` and `remove_artifact` keep the filing in step. Through
 * the real MCP server, as the model calls it. With the hub off the tools are what they were.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventType, type GladeEvent } from '../../shared/bridge'
import { ArtifactKind, ToolCallState } from '../../shared/domain'
import { ChildKind, FilingSource } from '../../shared/todoHub'
import { addTaskLinkByHand, removeTaskArtifact } from '../artifacts/artifacts'
import { listArtifacts } from '../db/repositories/artifacts'
import { listFilings } from '../db/repositories/child-filings'
import { listOwedFilings } from '../db/repositories/owed-filings'
import { updateSettings } from '../db/repositories/settings'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { appendToolCall, updateToolCall } from '../db/repositories/tool-events'
import { createQuestionBroker } from '../questions/questions'
import { NO_TODOS } from '../todo-hub/agent-children'
import { ARTIFACT_NEEDS_TODO, NOTHING_ADDED } from '../todo-hub/filing'
import { readTodoHub } from '../todo-hub/todo-hub'
import { ADD_ARTIFACT_TODO, createGladeMcpServer, GLADE_SERVER, type GladeToolContext } from './glade-tools'
import { createMcpToolCaller, type McpToolCaller, type McpToolOutcome } from './mcp-tool-caller'

const HUB_ON = { statusSummary: true, taskTitles: true, todoHubEnabled: true }
const PR = 'https://github.com/acme/api/pull/412'
const TODOS = 'Your todos: #1 Write the release notes (pending) · #2 Open the pull request (pending)'

let database: TestDatabase
let db: Database
let events: GladeEvent[]
let context: GladeToolContext
let root: string
let tools: McpToolCaller
let taskId: string
let clock: number

beforeEach(() => {
  database = openTestDatabase()
  db = database.db
  events = []
  clock = 1_000
  const base = { db, emit: (event: GladeEvent) => events.push(event) }
  context = { ...base, questions: createQuestionBroker(base) }
  root = mkdtempSync(join(tmpdir(), 'glade-artifact-todo-'))
  mkdirSync(join(root, 'docs', 'releases'), { recursive: true })
  writeFileSync(join(root, 'docs', 'releases', '2.4.md'), '# Release notes 2.4\n')
  writeFileSync(join(root, 'docs', 'releases', '2.4-final.md'), '# Release notes 2.4\n')
  taskId = sampleTask(db, sampleWorkspace(db, root).id).id
  updateSettings(db, { todoHubEnabled: true })
  tools = createMcpToolCaller({ [GLADE_SERVER]: createGladeMcpServer(context, taskId, HUB_ON) })
})

afterEach(async () => {
  await tools.close()
  database.close()
  rmSync(root, { recursive: true, force: true })
})

/** Adds a todo as Claude Code's `TaskCreate` does: the call's result names its id. */
function createTodo(id: string, subject: string): void {
  clock += 10
  const toolUseId = `toolu_create_${id}`
  appendToolCall(
    db,
    { taskId, turn: 1, name: 'TaskCreate', input: { subject }, toolUseId, parentToolUseId: null },
    clock,
  )
  const output = `Task #${id} created successfully: ${subject}`
  updateToolCall(db, { taskId, toolUseId, state: ToolCallState.Done, output }, clock)
}

function updateTodo(id: string, status: string): void {
  clock += 10
  const toolUseId = `toolu_${status}_${id}`
  const input = { taskId: id, status }
  appendToolCall(db, { taskId, turn: 1, name: 'TaskUpdate', input, toolUseId, parentToolUseId: null }, clock)
  updateToolCall(db, { taskId, toolUseId, state: ToolCallState.Done, output: `Updated task #${id} status` }, clock)
}

function twoTodos(): void {
  createTodo('1', 'Write the release notes')
  createTodo('2', 'Open the pull request')
}

function add(input: Record<string, unknown>): Promise<McpToolOutcome> {
  return tools.call('mcp__glade__add_artifact', input)
}

function filings(): string[] {
  return listFilings(db, taskId).map(({ kind, key, todoId, source }) => `${kind} ${key} #${todoId} ${source}`)
}

/** Each todo's children as `kind source`, sorted, then the ones under no todo. */
function placed(): string[][] {
  const { todos, unfiled } = readTodoHub(db, taskId).children
  return [...todos, unfiled].map((group) =>
    group.children.map(({ kind, source }) => `${kind} ${source ?? 'unfiled'}`).sort(),
  )
}

/** What the model is shown of a server's `add_artifact`: its description, and the fields it takes. */
async function addArtifactTool(
  settings: typeof HUB_ON | undefined,
): Promise<{ description: string; fields: string[] }> {
  const server = createGladeMcpServer(context, taskId, settings)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.instance.connect(serverSide)
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(clientSide)
  const tool = (await client.listTools()).tools.find(({ name }) => name === 'add_artifact')
  await client.close()
  return { description: tool?.description ?? '', fields: Object.keys(tool?.inputSchema.properties ?? {}) }
}

describe('add_artifact with the todo hub on', () => {
  it('takes the todo, and says it needs it; with the hub off it has no such field and reads as before', async () => {
    const on = await addArtifactTool(HUB_ON)
    const off = await addArtifactTool(undefined)

    expect(on.fields).toEqual(['path', 'url', 'title', 'todo'])
    expect(off.fields).toEqual(['path', 'url', 'title'])
    expect(on.description).toBe(`${off.description} ${ADD_ARTIFACT_TODO}`)
    expect(off.description).not.toMatch(/todo/i)
  })

  it('files a file and a link under the todo each call names, before the windows hear of the artifact', async () => {
    twoTodos()

    const file = await add({ path: 'docs/releases/2.4.md', title: 'Release notes 2.4', todo: '1' })
    const link = await add({ url: PR, title: 'Docs navigation', todo: '#2' })

    expect(file).toEqual({
      output: 'Added docs/releases/2.4.md to the artifacts as "Release notes 2.4". It\'s under todo #1.',
      isError: false,
    })
    expect(link.output).toBe(`Added ${PR} to the artifacts as "Docs navigation". It's under todo #2.`)
    expect(filings()).toEqual(['file docs/releases/2.4.md #1 named', `link ${PR} #2 named`])
    expect(placed()).toEqual([['file named'], ['link named'], []])
    // Each artifact reaches the windows already filed: its filing first, then the list it's in.
    expect(events.map(({ type }) => type)).toEqual([
      EventType.FilingsChanged,
      EventType.ArtifactsChanged,
      EventType.FilingsChanged,
      EventType.ArtifactsChanged,
    ])
    // Nothing the agent files itself in the call that makes it is ever owed.
    expect(listOwedFilings(db, taskId)).toEqual([])
  })

  it('files under a todo that is done', async () => {
    twoTodos()
    updateTodo('1', 'completed')

    expect((await add({ path: 'docs/releases/2.4.md', title: 'Release notes 2.4', todo: '1' })).isError).toBe(false)
    expect(filings()).toEqual(['file docs/releases/2.4.md #1 named'])
  })

  it('adds nothing without a todo, saying which the task has', async () => {
    twoTodos()

    expect(await add({ path: 'docs/releases/2.4.md', title: 'Release notes 2.4' })).toEqual({
      output: `${ARTIFACT_NEEDS_TODO} ${TODOS}`,
      isError: true,
    })
    expect(await add({ url: PR, title: 'Docs navigation' })).toEqual({
      output: `${ARTIFACT_NEEDS_TODO} ${TODOS}`,
      isError: true,
    })

    expect(listArtifacts(db, taskId)).toEqual([])
    expect(filings()).toEqual([])
    expect(events).toEqual([])
  })

  it('adds nothing for a todo that is not in the list: unknown, deleted, or with no list at all', async () => {
    expect(await add({ url: PR, title: 'Docs navigation', todo: '1' })).toEqual({
      output: `${NOTHING_ADDED} There's no todo #1 in this task's list. ${NO_TODOS}`,
      isError: true,
    })
    expect((await add({ url: PR, title: 'Docs navigation' })).output).toBe(`${ARTIFACT_NEEDS_TODO} ${NO_TODOS}`)
    twoTodos()
    expect((await add({ url: PR, title: 'Docs navigation', todo: '9' })).output).toBe(
      `${NOTHING_ADDED} There's no todo #9 in this task's list. ${TODOS}`,
    )
    updateTodo('2', 'deleted')
    expect(await add({ path: 'docs/releases/2.4.md', title: 'Release notes 2.4', todo: '2' })).toEqual({
      output: `${NOTHING_ADDED} There's no todo #2 in this task's list. Your todos: #1 Write the release notes (pending)`,
      isError: true,
    })

    expect(listArtifacts(db, taskId)).toEqual([])
    expect(filings()).toEqual([])
    expect(events).toEqual([])
  })

  it('files nothing when the artifact itself can’t be added', async () => {
    twoTodos()

    expect((await add({ path: 'docs/gone.md', title: 'Gone', todo: '1' })).isError).toBe(true)
    expect((await add({ url: 'ftp://example.com/x', title: 'Not a page', todo: '1' })).isError).toBe(true)
    expect((await add({ path: 'docs/releases/2.4.md', url: PR, title: 'Both', todo: '1' })).isError).toBe(true)

    expect(filings()).toEqual([])
    expect(events).toEqual([])
  })

  it('renames an artifact declared again under its todo, and moves one declared again under another', async () => {
    twoTodos()
    await add({ url: PR, title: 'Docs navigation', todo: '1' })
    const filedAt = listFilings(db, taskId)[0]?.filedAt
    events = []

    const renamed = await add({ url: PR, title: 'Docs navigation refresh', todo: '1' })
    expect(renamed).toMatchObject({
      output: expect.stringMatching(/ It's under todo #1\.$/) as unknown,
      isError: false,
    })
    expect(listArtifacts(db, taskId)).toMatchObject([{ title: 'Docs navigation refresh' }])
    expect(listFilings(db, taskId)).toMatchObject([{ todoId: '1', source: FilingSource.Named, filedAt }])
    expect(events.map(({ type }) => type)).toEqual([EventType.ArtifactsChanged])

    await add({ url: PR, title: 'Docs navigation refresh', todo: '2' })
    expect(filings()).toEqual([`link ${PR} #2 moved`])
  })
})

describe('update_artifact and remove_artifact with the todo hub on', () => {
  beforeEach(async () => {
    twoTodos()
    await add({ path: 'docs/releases/2.4.md', title: 'Release notes 2.4', todo: '1' })
    await add({ url: PR, title: 'Docs navigation', todo: '2' })
    events = []
  })

  it('keep a file under its todo when it’s pointed at another file, and a link when at another page', async () => {
    const before = listFilings(db, taskId)

    await tools.call('mcp__glade__update_artifact', {
      path: 'docs/releases/2.4.md',
      newPath: 'docs/releases/2.4-final.md',
    })
    await tools.call('mcp__glade__update_artifact', { url: PR, newUrl: 'https://github.com/acme/api/pull/413' })

    expect(filings()).toEqual([
      'file docs/releases/2.4-final.md #1 named',
      'link https://github.com/acme/api/pull/413 #2 named',
    ])
    expect(listFilings(db, taskId).map(({ filedAt }) => filedAt)).toEqual(before.map(({ filedAt }) => filedAt))
    expect(placed()).toEqual([['file named'], ['link named'], []])
    // The windows hear the filing move before the list that has the artifact at its new place.
    expect(events).toMatchObject([
      {
        type: EventType.FilingsChanged,
        filed: [{ kind: ChildKind.File, key: 'docs/releases/2.4-final.md', todoId: '1' }],
        removed: [{ kind: ChildKind.File, key: 'docs/releases/2.4.md' }],
      },
      { type: EventType.ArtifactsChanged },
      {
        type: EventType.FilingsChanged,
        filed: [{ kind: ChildKind.Link, key: 'https://github.com/acme/api/pull/413', todoId: '2' }],
        removed: [{ kind: ChildKind.Link, key: PR }],
      },
      { type: EventType.ArtifactsChanged },
    ])
  })

  it('leave the filing alone for a new title', async () => {
    await tools.call('mcp__glade__update_artifact', { path: 'docs/releases/2.4.md', title: 'The 2.4 notes' })
    await tools.call('mcp__glade__update_artifact', { url: PR, title: 'Navigation' })

    expect(filings()).toEqual(['file docs/releases/2.4.md #1 named', `link ${PR} #2 named`])
    expect(events.map(({ type }) => type)).toEqual([EventType.ArtifactsChanged, EventType.ArtifactsChanged])
  })

  it('take the filing away with the artifact, so one added again starts under no todo', async () => {
    await tools.call('mcp__glade__remove_artifact', { path: 'docs/releases/2.4.md' })
    removeTaskArtifact(context, taskId, { kind: ArtifactKind.Link, url: PR })

    expect(filings()).toEqual([])
    expect(events.map(({ type }) => type)).toEqual([
      EventType.FilingsChanged,
      EventType.ArtifactsChanged,
      EventType.FilingsChanged,
      EventType.ArtifactsChanged,
    ])
    // A link you add yourself (Add to artifacts) has no call to name a todo: it stays under none.
    addTaskLinkByHand(context, taskId, { url: PR, text: 'the PR' })
    expect(filings()).toEqual([])
    expect(placed()).toEqual([[], [], ['link unfiled']])
    expect(listOwedFilings(db, taskId)).toEqual([])
  })
})

describe('a session that has the hub’s add_artifact, once the hub is turned off', () => {
  it('adds the artifact as before, with or without a todo, filing nothing', async () => {
    updateSettings(db, { todoHubEnabled: false })

    expect(await add({ url: PR, title: 'Docs navigation' })).toEqual({
      output: `Added ${PR} to the artifacts as "Docs navigation".`,
      isError: false,
    })
    expect((await add({ path: 'docs/releases/2.4.md', title: 'Release notes 2.4', todo: '7' })).output).toBe(
      'Added docs/releases/2.4.md to the artifacts as "Release notes 2.4".',
    )

    expect(db.prepare('SELECT COUNT(*) FROM child_filings').pluck().get()).toBe(0)
    expect(events.map(({ type }) => type)).toEqual([EventType.ArtifactsChanged, EventType.ArtifactsChanged])
  })
})

describe('a session that started with the hub off', () => {
  it('has an add_artifact that takes no todo and files nothing, though the hub is on now', async () => {
    await tools.close()
    tools = createMcpToolCaller({ [GLADE_SERVER]: createGladeMcpServer(context, taskId) })
    twoTodos()

    // The SDK drops a field the tool doesn't have, so a todo given anyway changes nothing.
    expect(await add({ url: PR, title: 'Docs navigation', todo: '1' })).toEqual({
      output: `Added ${PR} to the artifacts as "Docs navigation".`,
      isError: false,
    })
    expect((await add({ path: 'docs/releases/2.4.md', title: 'Release notes 2.4' })).isError).toBe(false)

    expect(filings()).toEqual([])
    expect(placed()).toEqual([[], [], ['file unfiled', 'link unfiled']])
  })
})
