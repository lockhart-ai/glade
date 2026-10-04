// `list_children` and `file_children` as a session has them (P16-05, #496): over MCP, as the SDK calls them, so each
// call's input is checked against its schema; and through the app's own wiring, which gives a session the two tools and
// the prompt's line about them only when it starts with the todo hub's hidden switch on.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { CommandName, EventType, type GladeEvent } from '../../shared/bridge'
import { ToolCallState, type Task } from '../../shared/domain'
import { ChildKind, FilingSource } from '../../shared/todoHub'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { addArtifact, addLinkArtifact } from '../db/repositories/artifacts'
import { listFilings } from '../db/repositories/child-filings'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { appendToolCall, updateToolCall } from '../db/repositories/tool-events'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { createQuestionBroker } from '../questions/questions'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { NOTHING_FILED } from '../todo-hub/agent-children'
import { readTodoHub } from '../todo-hub/todo-hub'
import { FakeAgentBackend, settle } from './fake-backend'
import {
  createGladeMcpServer,
  createGladeToolHandlers,
  GLADE_SERVER,
  GladeTool,
  type AgentUpkeep,
  type GladeToolContext,
} from './glade-tools'
import { createMcpToolCaller, type McpToolCaller } from './mcp-tool-caller'
import { TODO_HUB_TOOLS_LINE } from './system-prompt'

let database: TestDatabase
let db: Database
let task: Task
let events: GladeEvent[]
let context: GladeToolContext
let caller: McpToolCaller

beforeEach(() => {
  database = openTestDatabase()
  db = database.db
  task = sampleTask(db, sampleWorkspace(db).id)
  events = []
  const base = { db, emit: (event: GladeEvent) => events.push(event) }
  context = { ...base, questions: createQuestionBroker(base) }
  caller = createMcpToolCaller({ [GLADE_SERVER]: createGladeMcpServer(context, task.id) })
})

afterEach(async () => {
  await caller.close()
  database.close()
})

/** A todo, as Claude Code's `TaskCreate` leaves one in the tool log. */
function createTodo(id: string, subject: string): void {
  const toolUseId = `toolu_create_${id}`
  appendToolCall(db, {
    taskId: task.id,
    turn: 1,
    name: 'TaskCreate',
    input: { subject },
    toolUseId,
    parentToolUseId: null,
  })
  updateToolCall(db, {
    taskId: task.id,
    toolUseId,
    state: ToolCallState.Done,
    output: `Task #${id} created successfully: ${subject}`,
  })
}

/** A task with two todos and two artifacts made before anything filed them: c1 the notes, c2 the PR. */
function unsorted(): void {
  createTodo('1', 'Draft the release notes')
  createTodo('2', 'Open the PR')
  addArtifact(db, { taskId: task.id, path: 'docs/releases/2.4.md', title: 'Release notes 2.4' }, 4_000)
  addLinkArtifact(db, { taskId: task.id, url: 'https://example.com/acme/api/pull/42', title: 'PR #42' }, 4_100)
}

/** The tools a server lists, as the SDK would read them. */
async function toolsOf(settings?: AgentUpkeep) {
  const server = createGladeMcpServer(context, task.id, settings)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.instance.connect(serverSide)
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(clientSide)
  const { tools } = await client.listTools()
  await client.close()
  return tools
}

const list = (input: Record<string, unknown> = {}) => caller.call('mcp__glade__list_children', input)
const file = (input: Record<string, unknown>) => caller.call('mcp__glade__file_children', input)

describe('the server', () => {
  it('has the two tools in every session, loaded up front like the rest', async () => {
    const tools = await toolsOf()

    expect(tools.map(({ name }) => name).slice(-3)).toEqual([
      GladeTool.RemoveArtifact,
      GladeTool.ListChildren,
      GladeTool.FileChildren,
    ])
    for (const listed of tools) expect(listed._meta).toEqual({ 'anthropic/alwaysLoad': true })

    // Whatever upkeep the session has: they aren't upkeep.
    const names = (await toolsOf({ statusSummary: false, taskTitles: false })).map(({ name }) => name)
    expect(names).toContain(GladeTool.ListChildren)
    expect(names).toContain(GladeTool.FileChildren)
  })

  it('takes an optional todo to list by, and one or more filings, each a child and a todo', async () => {
    const tools = await toolsOf()
    const schema = (name: string) => tools.find((listed) => listed.name === name)?.inputSchema

    expect(schema(GladeTool.ListChildren)).toMatchObject({ properties: { todo: { type: 'string' } } })
    expect(schema(GladeTool.ListChildren)?.required).toBeUndefined()
    expect(schema(GladeTool.FileChildren)).toMatchObject({
      required: ['filings'],
      properties: {
        filings: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['child', 'todo'],
            properties: { child: { type: 'string' }, todo: { type: 'string' } },
          },
        },
      },
    })
  })
})

describe('the two tools, called as the agent calls them', () => {
  it('lists a task’s unfiled children, files each under a todo in one call, and leaves the placeholder empty', async () => {
    unsorted()

    await expect(list()).resolves.toEqual({
      isError: false,
      output: [
        '#1 Draft the release notes (pending), no children',
        '#2 Open the PR (pending), no children',
        'Not under a todo, 2 children:',
        '- c1: file "Release notes 2.4"',
        '- c2: link "PR #42"',
      ].join('\n'),
    })
    await expect(
      file({
        filings: [
          { child: 'c1', todo: '1' },
          { child: 'c2', todo: '2' },
        ],
      }),
    ).resolves.toEqual({ isError: false, output: 'Filed 2 children: c1 under #1; c2 under #2.' })

    await expect(list({ todo: 'none' })).resolves.toEqual({ isError: false, output: 'Not under a todo, no children' })
    await expect(list({ todo: '2' })).resolves.toEqual({
      isError: false,
      output: '#2 Open the PR (pending), 1 child:\n- c2: link "PR #42"',
    })
    expect(readTodoHub(db, task.id).children.unfiled.children).toEqual([])
    // The panel hears the filings, as it hears any.
    expect(events).toEqual([
      {
        type: EventType.FilingsChanged,
        taskId: task.id,
        filed: [
          expect.objectContaining({ kind: ChildKind.File, todoId: '1', source: FilingSource.Asked }),
          expect.objectContaining({ kind: ChildKind.Link, todoId: '2', source: FilingSource.Asked }),
        ],
        removed: [],
      },
    ])
  })

  it('answers a bad todo or child with a tool error saying which, and files nothing', async () => {
    unsorted()
    await list()

    const filings = [
      { child: 'c1', todo: '1' },
      { child: 'c7', todo: '5' },
    ]
    await expect(file({ filings })).resolves.toEqual({
      isError: true,
      output:
        `${NOTHING_FILED} Not a child of this task: c7. List the task's children for their ids. There's no todo #5 ` +
        "in this task's list. Your todos: #1 Draft the release notes (pending) · #2 Open the PR (pending)",
    })
    await expect(list({ todo: '5' })).resolves.toMatchObject({
      isError: true,
      output: expect.stringMatching(/^There's no todo #5 in this task's list\. Your todos: #1 /) as unknown,
    })
    expect(listFilings(db, task.id)).toEqual([])
    expect(events).toEqual([])
  })

  it.each([
    ['no filings at all', {}],
    ['an empty list of filings', { filings: [] }],
    ['a filing with no todo', { filings: [{ child: 'c1' }] }],
    ['a filing with no child', { filings: [{ todo: '1' }] }],
    ['a blank child', { filings: [{ child: '  ', todo: '1' }] }],
    ['a blank todo', { filings: [{ child: 'c1', todo: '' }] }],
    ['a todo given as a number', { filings: [{ child: 'c1', todo: 1 }] }],
    ['filings that aren’t a list', { filings: { child: 'c1', todo: '1' } }],
    ['one bad filing after a good one', { filings: [{ child: 'c1', todo: '1' }, { child: 'c2' }] }],
  ])('refuses %s before the handler runs, and files nothing', async (_what, input) => {
    unsorted()
    await list()

    await expect(file(input)).resolves.toMatchObject({ isError: true })
    expect(listFilings(db, task.id)).toEqual([])
    expect(events).toEqual([])
  })

  it('refuses a todo to list by that is blank or isn’t text', async () => {
    unsorted()

    await expect(list({ todo: ' ' })).resolves.toMatchObject({ isError: true })
    await expect(list({ todo: 2 })).resolves.toMatchObject({ isError: true })
  })

  it('has handlers that answer as the tools do', () => {
    unsorted()
    const handlers = createGladeToolHandlers(context, task.id)

    expect(handlers.listChildren({ todo: 'none' })).toEqual({
      content: [
        { type: 'text', text: 'Not under a todo, 2 children:\n- c1: file "Release notes 2.4"\n- c2: link "PR #42"' },
      ],
    })
    expect(handlers.fileChildren({ filings: [{ child: 'c2', todo: '#1' }] })).toEqual({
      content: [{ type: 'text', text: 'Filed 1 child: c2 under #1.' }],
    })
    expect(handlers.fileChildren({ filings: [{ child: 'c2', todo: '3' }] })).toMatchObject({ isError: true })
    expect(handlers.listChildren({ todo: '3' })).toMatchObject({ isError: true })
  })
})

describe('through the app’s own wiring', () => {
  /** Starts the task's session as the app does, and answers with what it was started with. */
  async function startSession() {
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
    await createBridge(ipc.renderer).invoke(CommandName.TasksSend, { id: task.id, text: 'File your things.' })
    await settle()
    const { options } = agents.session
    const server = options.mcpServers[GLADE_SERVER]
    if (server?.type !== 'sdk') throw new Error('Glade’s tools aren’t an in-process server')
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.instance.connect(serverSide)
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(clientSide)
    const tools = (await client.listTools()).tools.map(({ name }) => name)
    await client.close()
    return { tools, prompt: options.systemPromptAppend }
  }

  it('gives a session the two tools, and the prompt’s one line about them', async () => {
    const { tools, prompt } = await startSession()

    expect(tools).toContain(GladeTool.ListChildren)
    expect(tools).toContain(GladeTool.FileChildren)
    expect(prompt.split(TODO_HUB_TOOLS_LINE)).toHaveLength(2)
  })
})
