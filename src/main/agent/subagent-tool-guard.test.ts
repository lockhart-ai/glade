/**
 * The subagent tool guard end to end (#366): simulates the order Claude Code documents (`docs/sdk-notes.md` §9) for a
 * `PreToolUse` hook that denies a call — decided before the tool ever dispatches — against the real `glade` MCP
 * server, so a denied `ask` really can be shown to never open a question card, under both permission modes, not just
 * asserted of the hook in isolation (`sdk-backend.hooks.test.ts`).
 *
 * The mocked SDK backend used elsewhere (`scripted-session.ts`) never calls these hooks at all: they're Claude Code's
 * own plumbing, invisible to Glade's fake agent. This test stands in for that missing piece by driving the guard hook
 * `sdkOptions` gives the SDK, then, only when it doesn't deny, calling the tool over MCP as the SDK would.
 */
import type { HookCallback, HookInput } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventType, type GladeEvent } from '../../shared/bridge'
import { Effort, PermissionMode, TodoState, ToolCallState, type Task } from '../../shared/domain'
import { addArtifact } from '../db/repositories/artifacts'
import { listFilings } from '../db/repositories/child-filings'
import { putTodos, seedTodoCounterAtLeast } from '../db/repositories/glade-todos'
import { getOpenQuestionSet } from '../db/repositories/question-sets'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { appendToolCall, updateToolCall } from '../db/repositories/tool-events'
import { createQuestionBroker } from '../questions/questions'
import type { AgentSessionOptions } from './backend'
import { createGladeMcpServer, GLADE_SERVER, type GladeToolContext } from './glade-tools'
import { createMcpToolCaller, type McpToolCaller } from './mcp-tool-caller'
import { sdkOptions } from './sdk-backend'
import { refusedTaskMessage } from '../tasks/task-messages'

const BASE_OPTIONS: AgentSessionOptions = {
  cwd: '/code/acme-api',
  model: 'claude-sample-1',
  effort: Effort.High,
  permissionMode: PermissionMode.AllowAll,
  resumeSessionId: null,
  systemPromptAppend: '',
  mcpServers: {},
}

/** What the SDK would fire the guard with, for one call. */
function preToolUseInput(toolName: string, agentId: string | null): HookInput {
  return {
    session_id: 's1',
    transcript_path: '/tmp/s1.jsonl',
    cwd: '/code/acme-api',
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: {},
    tool_use_id: 'toolu_1',
    mcp_server: { name: GLADE_SERVER, source: 'sdk' },
    ...(agentId === null ? {} : { agent_id: agentId }),
  } as unknown as HookInput
}

/** The subagent tool guard `sdkOptions` gives the SDK for a session in `mode`. */
function guardFor(mode: PermissionMode): HookCallback {
  const options = sdkOptions({ ...BASE_OPTIONS, permissionMode: mode }, {})
  const [matcher] = options.hooks?.PreToolUse ?? []
  const [hook] = matcher?.hooks ?? []
  if (hook === undefined) throw new Error('no subagent tool guard')
  return hook
}

/** Whether the guard denied the call: its `hookSpecificOutput`, narrowed to what `PreToolUse` gives. */
function denialOf(decision: Awaited<ReturnType<HookCallback>>): string | null {
  const output =
    'hookSpecificOutput' in decision && decision.hookSpecificOutput?.hookEventName === 'PreToolUse'
      ? decision.hookSpecificOutput
      : undefined
  return output?.permissionDecision === 'deny' ? (output.permissionDecisionReason ?? '') : null
}

/**
 * Dispatches a tool call the way Claude Code does: the guard decides first, and only when it doesn't deny does the
 * call reach the tool over MCP.
 */
async function dispatch(
  caller: McpToolCaller,
  mode: PermissionMode,
  toolName: string,
  input: Record<string, unknown>,
  agentId: string | null,
): Promise<{ readonly dispatched: boolean; readonly output: string; readonly isError: boolean }> {
  const decision = await guardFor(mode)(preToolUseInput(toolName, agentId), 'toolu_1', {
    signal: new AbortController().signal,
  })
  const denial = denialOf(decision)
  if (denial !== null) return { dispatched: false, output: denial, isError: true }
  const outcome = await caller.call(toolName, input)
  return { dispatched: true, ...outcome }
}

describe.each([
  ['Allow all', PermissionMode.AllowAll],
  ['the ask mode', PermissionMode.AskBeforeEdits],
])('under %s', (_label, mode) => {
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
    context = {
      ...base,
      questions: createQuestionBroker(base),
      // No test here sends a task message; message_task's own tests override this.
      deliverTaskMessage: () => refusedTaskMessage('not wired in this test'),
    }
    caller = createMcpToolCaller({ [GLADE_SERVER]: createGladeMcpServer(context, task.id) })
  })

  afterEach(async () => {
    await caller.close()
    database.close()
  })

  const QUESTIONS = [{ kind: 'pills', prompt: 'Ship it?', options: ['Yes', 'No'] }]

  it("never opens a question card for a subagent's ask, unlike the main agent's", async () => {
    const bySubagent = await dispatch(caller, mode, 'mcp__glade__ask', { questions: QUESTIONS }, 'sub-1')

    expect(bySubagent).toEqual({
      dispatched: false,
      isError: true,
      output: "Only the main agent can use Glade's tools. Report what you have to the agent that started you instead.",
    })
    expect(getOpenQuestionSet(database.db, task.id)).toBeUndefined()
    expect(events.filter((event) => event.type === EventType.QuestionOpened)).toEqual([])

    // The main agent's own call still opens one: the guard only refuses a subagent's.
    const outcome = caller.call('mcp__glade__ask', { questions: QUESTIONS })
    const open = await vi.waitFor(() => {
      const set = getOpenQuestionSet(database.db, task.id)
      if (set === undefined) throw new Error('No question is open yet')
      return set
    })
    expect(open).toMatchObject({ taskId: task.id, questions: QUESTIONS })
    context.questions.withdraw(task.id)
    await outcome
  })

  it("refuses a subagent's set_status and add_artifact too, leaving the task unchanged", async () => {
    const before = getTask(database.db, task.id)

    const status = await dispatch(caller, mode, 'mcp__glade__set_status', { status: 'Done' }, 'sub-1')
    const artifact = await dispatch(
      caller,
      mode,
      'mcp__glade__add_artifact',
      { path: 'README.md', title: 'Notes' },
      'sub-1',
    )

    expect(status.dispatched).toBe(false)
    expect(artifact.dispatched).toBe(false)
    expect(getTask(database.db, task.id)).toEqual(before)
    expect(events).toEqual([])
  })

  it("lets the main agent's set_status and add_artifact run", async () => {
    const status = await dispatch(caller, mode, 'mcp__glade__set_status', { status: 'Done' }, null)

    expect(status).toEqual({ dispatched: true, output: 'Status updated.', isError: false })
    expect(getTask(database.db, task.id)?.status).toBe('Done')
  })

  it("refuses a subagent's list_children and file_children, the todo hub's tools, and runs the main agent's", async () => {
    // A session has the two tools (P16-05, #496); the task has a todo and a file.
    const { db } = database
    const hub = createMcpToolCaller({ [GLADE_SERVER]: createGladeMcpServer(context, task.id) })
    const todo = { taskId: task.id, toolUseId: 'toolu_create_1' }
    appendToolCall(db, { ...todo, turn: 1, name: 'TaskCreate', input: { subject: 'Plan' }, parentToolUseId: null })
    updateToolCall(db, { ...todo, state: ToolCallState.Done, output: 'Task #1 created successfully: Plan' })
    putTodos(db, task.id, [{ id: '1', text: 'Plan', note: null, state: TodoState.Todo, completedAt: null }])
    seedTodoCounterAtLeast(db, task.id, 2)
    addArtifact(db, { taskId: task.id, path: 'docs/plan.md', title: 'The plan' })
    const filings = [{ child: 'c1', todo: '1' }]
    const named = (): unknown => db.prepare('SELECT COUNT(*) FROM child_ids').pluck().get()

    const listed = await dispatch(hub, mode, 'mcp__glade__list_children', {}, 'sub-1')
    const filed = await dispatch(hub, mode, 'mcp__glade__file_children', { filings }, 'sub-1')

    for (const refused of [listed, filed]) {
      expect(refused).toMatchObject({ dispatched: false, isError: true })
      expect(refused.output).toContain("Only the main agent can use Glade's tools.")
    }
    // Nothing was named to the subagent, filed, or sent to the windows.
    expect(named()).toBe(0)
    expect(listFilings(db, task.id)).toEqual([])
    expect(events).toEqual([])

    await expect(dispatch(hub, mode, 'mcp__glade__list_children', {}, null)).resolves.toMatchObject({
      dispatched: true,
      isError: false,
      output: expect.stringContaining('- c1: file "The plan"') as unknown,
    })
    await expect(dispatch(hub, mode, 'mcp__glade__file_children', { filings }, null)).resolves.toEqual({
      dispatched: true,
      isError: false,
      output: 'Filed 1 child: c1 under #1.',
    })
    expect(listFilings(db, task.id)).toHaveLength(1)
    await hub.close()
  })

  it("refuses a subagent's create_todo, update_todo and list_todos, and runs the main agent's (#609)", async () => {
    const todos = createMcpToolCaller({ [GLADE_SERVER]: createGladeMcpServer(context, task.id) })

    const created = await dispatch(todos, mode, 'mcp__glade__create_todo', { subject: 'Plan' }, 'sub-1')
    expect(created).toMatchObject({ dispatched: false, isError: true })
    expect(created.output).toContain("Only the main agent can use Glade's tools.")
    // Nothing was made, so nothing to update or list by the subagent either.
    const updated = await dispatch(todos, mode, 'mcp__glade__update_todo', { id: '1', note: 'Planning' }, 'sub-1')
    const listed = await dispatch(todos, mode, 'mcp__glade__list_todos', {}, 'sub-1')
    for (const refused of [updated, listed]) {
      expect(refused).toMatchObject({ dispatched: false, isError: true })
      expect(refused.output).toContain("Only the main agent can use Glade's tools.")
    }
    expect(events).toEqual([])

    // The main agent's own calls run, same as any other Glade tool.
    await expect(dispatch(todos, mode, 'mcp__glade__create_todo', { subject: 'Plan' }, null)).resolves.toMatchObject({
      dispatched: true,
      isError: false,
      output: 'Todo #1 created: Plan.',
    })
    await expect(
      dispatch(todos, mode, 'mcp__glade__update_todo', { id: '1', note: 'Planning' }, null),
    ).resolves.toEqual({ dispatched: true, isError: false, output: 'Todo #1 updated.' })
    await expect(dispatch(todos, mode, 'mcp__glade__list_todos', {}, null)).resolves.toMatchObject({
      dispatched: true,
      isError: false,
      output: '#1 [pending] Plan — Planning',
    })
    await todos.close()
  })

  it("lets a subagent's list_other_tasks run too (#578), alone with request_access among Glade's own tools", async () => {
    const other = sampleTask(database.db, sampleWorkspace(database.db, '/code/widgets').id)

    const bySubagent = await dispatch(caller, mode, 'mcp__glade__list_other_tasks', {}, 'sub-1')

    expect(bySubagent).toMatchObject({ dispatched: true, isError: false })
    expect(bySubagent.output).toContain(task.id)
    expect(bySubagent.output).toContain(other.id)
    // Every other Glade tool is still refused to that very subagent, request_access apart (its own test elsewhere).
    for (const toolName of [
      'mcp__glade__set_title',
      'mcp__glade__set_objective',
      'mcp__glade__set_status',
      'mcp__glade__ask',
      'mcp__glade__show_file',
      'mcp__glade__add_artifact',
      'mcp__glade__update_artifact',
      'mcp__glade__remove_artifact',
    ]) {
      const refused = await dispatch(caller, mode, toolName, {}, 'sub-1')
      expect(refused).toMatchObject({ dispatched: false, isError: true })
      expect(refused.output).toContain("Only the main agent can use Glade's tools.")
    }
    // The main agent's own call runs too, the same as a subagent's.
    await expect(dispatch(caller, mode, 'mcp__glade__list_other_tasks', {}, null)).resolves.toMatchObject({
      dispatched: true,
      isError: false,
    })
  })
})
