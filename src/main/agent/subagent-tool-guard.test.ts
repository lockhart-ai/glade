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
import { Effort, PermissionMode, type Task } from '../../shared/domain'
import { getOpenQuestionSet } from '../db/repositories/question-sets'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { createQuestionBroker } from '../questions/questions'
import type { AgentSessionOptions } from './backend'
import { createGladeMcpServer, GLADE_SERVER, type GladeToolContext } from './glade-tools'
import { createMcpToolCaller, type McpToolCaller } from './mcp-tool-caller'
import { sdkOptions } from './sdk-backend'

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
    context = { ...base, questions: createQuestionBroker(base) }
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
})
