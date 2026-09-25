import { createSdkMcpServer, tool as mcpTool } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CompactionTrigger, Effort, PermissionMode, QuestionKind, QuestionReplyKind } from '../../shared/domain'
import {
  ToolPermissionBehavior,
  type AgentSessionOptions,
  type ToolPermissionAnswer,
  type ToolPermissionCall,
} from './backend'
import { AgentEventKind, createSdkMessageParser, TaskOutcome, type AgentEvent } from './events'
import { answeredAfterRestart, COMPACT_COMMAND, RESUME_PROMPT } from './runner'
import { NO_ONE_TO_ASK } from './sdk-backend'
import {
  gladeToolName,
  LAUNCHED_OUTPUT,
  REJECTED_TOOL_OUTPUT,
  ScriptedSession,
  type ScriptedSessionOptions,
} from './scripted-session'
import {
  ask,
  background,
  compact,
  delay,
  emit,
  fail,
  fillContext,
  gladeTool,
  init,
  permission,
  bashSuggestions,
  result,
  say,
  tool,
  toolResult,
  toolUse,
  waitForInterrupt,
  wake,
  type AgentScript,
  type ScriptTurn,
} from './scripts'

/** The titles the fake Glade server's `set_title` was given. */
let titles: string[] = []

/** The `ask` call the fake Glade server is waiting on: answer it with its answers' JSON; null when none waits. */
let asked: { readonly answer: (json: string) => void; readonly signal: AbortSignal } | null = null

/** A stand-in for the Glade server, with the real server's name and a `set_title` tool. */
function gladeServer() {
  return createSdkMcpServer({
    name: 'glade',
    tools: [
      mcpTool('set_title', 'Name the task.', { title: z.string() }, ({ title }) => {
        titles.push(title)
        return Promise.resolve({ content: [{ type: 'text', text: 'Title set.' }] })
      }),
      mcpTool('ask', 'Ask the user.', { questions: z.array(z.unknown()) }, (_input, extra) => {
        const { signal } = extra as { signal: AbortSignal }
        return new Promise((resolve) => {
          asked = {
            answer: (json) => {
              resolve({ content: [{ type: 'text', text: json }] })
            },
            signal,
          }
        })
      }),
    ],
  })
}

const SESSION: AgentSessionOptions = {
  cwd: '/code/acme-api',
  model: 'claude-sample-1',
  effort: Effort.High,
  permissionMode: PermissionMode.AllowAll,
  resumeSessionId: null,
  systemPromptAppend: '',
  mcpServers: {},
}

/** A session on a script, with everything it streams collected, parsed as the runner would parse it. */
interface Played {
  readonly session: ScriptedSession
  /** The raw SDK messages. */
  readonly raw: Record<string, unknown>[]
  /** What the runner would make of them, but for the context usage each assistant message reports. */
  readonly events: AgentEvent[]
  /** The context usage each top-level assistant message reports, in tokens. */
  readonly contextUsed: number[]
  /** How many times the session went idle. */
  readonly idles: () => number
  /** Resolves when the stream ends, or with the error it failed with. */
  readonly ended: Promise<Error | null>
  readonly warnings: unknown[]
}

let ids: number

function play(turns: readonly ScriptTurn[], options: Partial<ScriptedSessionOptions> = {}): Played {
  const script: AgentScript = { name: 'test', turns }
  let idles = 0
  const session = new ScriptedSession({
    script,
    session: { ...SESSION, mcpServers: { glade: gladeServer() } },
    newId: () => `id-${String((ids += 1))}`,
    onIdle: () => {
      idles += 1
    },
    ...options,
  })
  const raw: Record<string, unknown>[] = []
  const events: AgentEvent[] = []
  const contextUsed: number[] = []
  const warnings: unknown[] = []
  const parse = createSdkMessageParser({ warn: (...args) => warnings.push(args) })
  const ended = (async (): Promise<Error | null> => {
    try {
      for await (const message of session.messages) {
        raw.push(message as Record<string, unknown>)
        for (const event of parse(message)) {
          if (event.kind === AgentEventKind.ContextUsed) contextUsed.push(event.tokens)
          else events.push(event)
        }
      }
      return null
    } catch (error) {
      return error as Error
    }
  })()
  return { session, raw, events, contextUsed, idles: () => idles, ended, warnings }
}

/** Lets the session play everything it can without time passing. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  ids = 0
  titles = []
  asked = null
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ScriptedSession', () => {
  it('starts each turn with an init for its session, naming its folder, model and MCP servers', async () => {
    const played = play([[init(), result()]])
    played.session.send('Hi', 'user-1')
    await flush()

    expect(played.raw[0]).toMatchObject({
      type: 'system',
      subtype: 'init',
      session_id: 'id-1',
      cwd: '/code/acme-api',
      model: 'claude-sample-1',
      tools: expect.arrayContaining(['Bash', 'mcp__glade']) as unknown,
      mcp_servers: [{ name: 'glade', status: 'connected', source: 'sdk' }],
    })
    expect(played.events[0]).toEqual({
      kind: AgentEventKind.SessionStarted,
      sessionId: 'id-1',
      model: 'claude-sample-1',
    })
    expect(played.warnings).toEqual([])
  })

  it('keeps the session id it resumes', async () => {
    const played = play([[init()]], { session: { ...SESSION, resumeSessionId: 'resumed' } })
    played.session.send('Hi', 'user-1')
    await flush()
    expect(played.raw.map((message) => message.session_id)).toEqual(['resumed'])
  })

  it('makes ids with randomUUID by default', async () => {
    const played = play([[init()]], { newId: undefined })
    played.session.send('Hi', 'user-1')
    await flush()
    expect(played.raw[0]?.session_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('ends a turn with a result carrying its last top-level text, usage and measured duration', async () => {
    const played = play([[say('Looking.'), delay(1_500), say('Done.'), result()]])
    played.session.send('Fix it', 'user-1')
    await flush()
    expect(played.events).toEqual([{ kind: AgentEventKind.Text, text: 'Looking.', parentToolUseId: null }])

    await vi.advanceTimersByTimeAsync(1_500)
    const last = played.raw.at(-1)
    expect(last).toMatchObject({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
      terminal_reason: 'completed',
      duration_ms: 1_500,
      total_cost_usd: 0.0285,
      user_message_uuids: ['user-1'],
    })
    expect(played.events.at(-1)).toMatchObject({
      kind: AgentEventKind.TurnFinished,
      isError: false,
      result: 'Done.',
      durationMs: 1_500,
      usage: { inputTokens: 28, outputTokens: 553, cacheReadInputTokens: 58094, cacheCreationInputTokens: 9443 },
      contextWindows: { 'claude-sample-1': 200_000 },
    })
    expect(played.contextUsed).toEqual([22_846, 22_846])
    expect(played.idles()).toBe(1)
  })

  it('ends a failed turn with the errors and extra fields its result step gives', async () => {
    const played = play([
      [result({ text: '', isError: true, terminalReason: 'api_error', errors: ['Overloaded'], extra: { x: 1 } })],
    ])
    played.session.send('Hi', 'user-1')
    await flush()
    expect(played.raw[0]).toMatchObject({ is_error: true, terminal_reason: 'api_error', errors: ['Overloaded'], x: 1 })
    expect(played.events).toEqual([
      expect.objectContaining({ kind: AgentEventKind.TurnFinished, isError: true, errors: ['Overloaded'] }),
    ])
  })

  it('ends a subagent the turn waited on as failed when its call fails', async () => {
    const played = play([
      [
        toolUse('agent', 'Task', { description: 'Look', prompt: 'Look around.' }),
        toolResult('agent', 'Gave up.', true),
      ],
    ])
    played.session.send('Go', 'user-1')
    await flush()

    expect(played.raw.find((message) => message.subtype === 'task_started')).toMatchObject({
      tool_use_id: 'toolu_id2_1_agent',
      description: 'Look',
      prompt: 'Look around.',
      subagent_type: 'general-purpose',
      is_backgrounded: false,
      task_type: 'local_agent',
    })
    expect(played.events).toContainEqual(
      expect.objectContaining({ kind: AgentEventKind.TaskFinished, outcome: TaskOutcome.Failed, summary: 'Gave up.' }),
    )
  })

  it('streams tool calls and results with unique ids, one assistant message per round, subagent calls nested', async () => {
    const played = play([
      [
        say('Checking.'),
        ...tool('read', 'Read', { file_path: 'a.ts' }, 'contents'),
        toolUse('agent', 'Agent', { description: 'Look' }),
        ...tool('inner', 'Grep', { pattern: 'x' }, 'hit', 'agent'),
        say('Subagent text', 'agent'),
        toolResult('agent', 'Found it.'),
        toolResult('never-called', 'orphan', true),
      ],
    ])
    played.session.send('Go', 'user-1')
    await flush()

    const prefix = 'toolu_id2_1_'
    expect(played.events).toEqual([
      { kind: AgentEventKind.Text, text: 'Checking.', parentToolUseId: null },
      {
        kind: AgentEventKind.ToolCallStarted,
        toolUseId: `${prefix}read`,
        name: 'Read',
        input: { file_path: 'a.ts' },
        parentToolUseId: null,
      },
      {
        kind: AgentEventKind.ToolResult,
        toolUseId: `${prefix}read`,
        output: 'contents',
        isError: false,
        launched: false,
      },
      {
        kind: AgentEventKind.ToolCallStarted,
        toolUseId: `${prefix}agent`,
        name: 'Agent',
        input: { description: 'Look' },
        parentToolUseId: null,
      },
      // A subagent the turn waits on starts as a task, and ends before its call's result.
      { kind: AgentEventKind.SubagentStarted, sdkTaskId: 'aid21', toolUseId: `${prefix}agent`, background: false },
      {
        kind: AgentEventKind.ToolCallStarted,
        toolUseId: `${prefix}inner`,
        name: 'Grep',
        input: { pattern: 'x' },
        parentToolUseId: `${prefix}agent`,
      },
      { kind: AgentEventKind.ToolResult, toolUseId: `${prefix}inner`, output: 'hit', isError: false, launched: false },
      { kind: AgentEventKind.Text, text: 'Subagent text', parentToolUseId: `${prefix}agent` },
      {
        kind: AgentEventKind.TaskFinished,
        sdkTaskId: 'aid21',
        toolUseId: `${prefix}agent`,
        outcome: TaskOutcome.Completed,
        summary: 'Found it.',
      },
      {
        kind: AgentEventKind.ToolResult,
        toolUseId: `${prefix}agent`,
        output: 'Found it.',
        isError: false,
        launched: false,
      },
      {
        kind: AgentEventKind.ToolResult,
        toolUseId: `${prefix}never-called`,
        output: 'orphan',
        isError: true,
        launched: false,
      },
    ])
    const messageIds = played.raw
      .filter((message) => message.type === 'assistant')
      .map((message) => (message.message as { id: string }).id)
    expect(messageIds).toEqual(['msg_id2_1_1', 'msg_id2_1_1', 'msg_id2_1_2', 'msg_id2_1_2', 'msg_id2_1_3'])
    expect(played.raw[1]).toMatchObject({ tool_use_meta: [{ id: `${prefix}read`, display_name: 'Read' }] })
    expect(played.raw.find((message) => message.type === 'user')).toMatchObject({
      tool_use_result: { stdout: 'contents', stderr: '' },
    })
  })

  it('calls a Glade tool through the session’s glade server, as the SDK would, and streams its outcome', async () => {
    const played = play([
      [gladeTool('title', 'set_title', { title: 'Fix it' }), gladeTool('bad', 'set_title', { title: 42 }), result()],
    ])
    played.session.send('Go', 'user-1')
    await flush()

    expect(titles).toEqual(['Fix it'])
    expect(played.events.slice(0, 4)).toEqual([
      expect.objectContaining({ kind: AgentEventKind.ToolCallStarted, name: 'mcp__glade__set_title' }),
      expect.objectContaining({ kind: AgentEventKind.ToolResult, output: 'Title set.', isError: false }),
      expect.objectContaining({ kind: AgentEventKind.ToolCallStarted, input: { title: 42 } }),
      expect.objectContaining({
        kind: AgentEventKind.ToolResult,
        output: expect.stringContaining('Input validation error') as unknown,
        isError: true,
      }),
    ])
    played.session.close()
  })

  it('kills the session, loudly, when it has no Glade server to call', async () => {
    const played = play([[gladeTool('title', 'set_title', {}), say('Never.')], [say('Nor this.')]], {
      session: { ...SESSION, mcpServers: {} },
    })
    played.session.send('Go', 'user-1')
    played.session.send('Again', 'user-2')
    await flush()
    expect((await played.ended)?.message).toBe('No in-process MCP server named glade')
    expect(played.events.map((event) => event.kind)).toEqual([AgentEventKind.ToolCallStarted])
    expect(played.idles()).toBe(2)
    expect(gladeToolName('set_status')).toBe('mcp__glade__set_status')
  })

  describe('an ask step', () => {
    const QUESTIONS = [{ kind: QuestionKind.Text, prompt: 'Anything else?' }] as const

    it('asks through the glade server, goes idle while it waits, then streams the answers and plays on', async () => {
      const played = play([[init(), ask('questions', QUESTIONS), say('Thanks.'), result()]])
      played.session.send('Go', 'user-1')
      await flush()

      expect(played.events.slice(1)).toEqual([
        expect.objectContaining({
          kind: AgentEventKind.ToolCallStarted,
          name: 'mcp__glade__ask',
          input: { questions: QUESTIONS },
        }),
      ])
      expect(played.idles()).toBe(1)

      asked?.answer('{"0":"No."}')
      await flush()

      expect(played.events.slice(2)).toEqual([
        expect.objectContaining({ kind: AgentEventKind.ToolResult, output: '{"0":"No."}', isError: false }),
        expect.objectContaining({ kind: AgentEventKind.Text, text: 'Thanks.' }),
        expect.objectContaining({ kind: AgentEventKind.TurnFinished, result: 'Thanks.' }),
      ])
      expect(played.idles()).toBe(1)
      played.session.close()
    })

    it('cancels the call on an interrupt, and ends the turn as interrupted during a tool', async () => {
      const played = play([[init(), ask('questions', QUESTIONS), say('Never.')]])
      played.session.send('Go', 'user-1')
      await flush()

      await played.session.interrupt()
      await flush()

      expect(asked?.signal.aborted).toBe(true)
      expect(played.events.slice(2)).toEqual([
        expect.objectContaining({ kind: AgentEventKind.ToolResult, output: REJECTED_TOOL_OUTPUT, isError: true }),
        expect.objectContaining({ kind: AgentEventKind.TurnFinished, terminalReason: 'aborted_tools' }),
      ])
    })

    it('streams no result for a call answered after its turn was interrupted', async () => {
      const played = play([[init(), ask('questions', QUESTIONS), say('Never.')]])
      played.session.send('Go', 'user-1')
      await flush()
      const pending = asked

      // The answer and the interrupt cross: the answer is on its way when the turn is interrupted.
      pending?.answer('{"0":"No."}')
      await played.session.interrupt()
      await flush()

      expect(played.events.filter((event) => event.kind === AgentEventKind.ToolResult)).toEqual([
        expect.objectContaining({ output: REJECTED_TOOL_OUTPUT, isError: true }),
      ])
    })

    it('kills the session, loudly, when it has no Glade server to ask through', async () => {
      const played = play([[ask('questions', QUESTIONS), say('Never.')]], { session: { ...SESSION, mcpServers: {} } })
      played.session.send('Go', 'user-1')
      await flush()

      expect((await played.ended)?.message).toBe('No in-process MCP server named glade')
    })
  })

  describe('a permission step', () => {
    const TEST = { command: 'npm test', description: 'Run the test suite' }

    /** A session in the ask mode, whose calls wait on `decide`, which records each. */
    function asking(turns: readonly ScriptTurn[], decide: (call: ToolPermissionCall) => Promise<ToolPermissionAnswer>) {
      return play(turns, {
        session: {
          ...SESSION,
          permissionMode: PermissionMode.AskBeforeEdits,
          mcpServers: { glade: gladeServer() },
          onToolPermission: decide,
        },
      })
    }

    /** An answer the test gives when it likes, and the calls asked about meanwhile. */
    function decider(): {
      readonly calls: ToolPermissionCall[]
      readonly decide: (call: ToolPermissionCall) => Promise<ToolPermissionAnswer>
      readonly give: (answer: ToolPermissionAnswer) => void
    } {
      const calls: ToolPermissionCall[] = []
      let give: (answer: ToolPermissionAnswer) => void = () => undefined
      return {
        calls,
        decide: (call) => {
          calls.push(call)
          return new Promise((resolve) => {
            give = resolve
          })
        },
        give: (answer) => {
          give(answer)
        },
      }
    }

    it('runs straight through in Allow all, asking nothing, as the SDK bypasses the check', async () => {
      const decide = vi.fn<(call: ToolPermissionCall) => Promise<ToolPermissionAnswer>>()
      const played = play([[init(), permission('test', 'Bash', TEST, 'All passed.'), result()]], {
        session: { ...SESSION, mcpServers: { glade: gladeServer() }, onToolPermission: decide },
      })
      played.session.send('Go', 'user-1')
      await flush()

      expect(decide).not.toHaveBeenCalled()
      expect(played.raw[0]).toMatchObject({ permissionMode: 'bypassPermissions' })
      expect(played.events.slice(1, 3)).toEqual([
        expect.objectContaining({ kind: AgentEventKind.ToolCallStarted, name: 'Bash', input: TEST }),
        expect.objectContaining({ kind: AgentEventKind.ToolResult, output: 'All passed.', isError: false }),
      ])
    })

    it("asks with the prompt sentence and the stray-key flag a step gives, as Claude Code's would", async () => {
      const { calls, decide } = decider()
      const played = asking(
        [
          [
            init(),
            permission('write', 'Write', { file_path: 'a.md', content: 'A' }, 'Written.', {
              title: 'Claude wants to create a.md',
              defaultToNo: true,
            }),
            result(),
          ],
        ],
        decide,
      )
      played.session.send('Go', 'user-1')
      await flush()

      expect(calls).toEqual([
        expect.objectContaining({ toolName: 'Write', title: 'Claude wants to create a.md', defaultToNo: true }),
      ])
      played.session.close()
    })

    it('asks about the call in the ask mode, going idle while it waits, then plays its result once allowed', async () => {
      const { calls, decide, give } = decider()
      const played = asking(
        [
          [
            init(),
            permission('test', 'Bash', TEST, 'All passed.', {
              description: 'Run the test suite',
              suggestions: bashSuggestions('npm test'),
            }),
            say('Done.'),
            result(),
          ],
        ],
        decide,
      )
      played.session.send('Go', 'user-1')
      await flush()

      expect(played.raw[0]).toMatchObject({ permissionMode: 'default' })
      expect(played.idles()).toBe(1)
      expect(calls).toEqual([
        expect.objectContaining({
          toolName: 'Bash',
          input: TEST,
          toolUseId: (played.events[1] as { toolUseId: string }).toolUseId,
          agentId: null,
          title: null,
          displayName: 'Bash',
          description: 'Run the test suite',
          suggestions: bashSuggestions('npm test'),
          defaultToNo: false,
        }),
      ])
      expect(played.events.slice(2)).toEqual([])

      give({ behavior: ToolPermissionBehavior.Allow, byUser: true })
      await flush()

      expect(played.events.slice(2)).toEqual([
        expect.objectContaining({ kind: AgentEventKind.ToolResult, output: 'All passed.', isError: false }),
        expect.objectContaining({ kind: AgentEventKind.Text, text: 'Done.' }),
        expect.objectContaining({ kind: AgentEventKind.TurnFinished, result: 'Done.' }),
      ])
      played.session.close()
    })

    it("plays a denial as the call's error result, and the turn plays on", async () => {
      const { decide, give } = decider()
      const played = asking(
        [[init(), permission('test', 'Bash', TEST, 'Never.'), say('Understood.'), result()]],
        decide,
      )
      played.session.send('Go', 'user-1')
      await flush()

      give({ behavior: ToolPermissionBehavior.Deny, message: 'Denied: use pnpm.', byUser: true })
      await flush()

      expect(played.events.slice(2)).toEqual([
        expect.objectContaining({ kind: AgentEventKind.ToolResult, output: 'Denied: use pnpm.', isError: true }),
        expect.objectContaining({ kind: AgentEventKind.Text, text: 'Understood.' }),
        expect.objectContaining({ kind: AgentEventKind.TurnFinished }),
      ])
    })

    it("names a subagent's call by its subagent, and nests it under its Agent call", async () => {
      const { calls, decide } = decider()
      const played = asking(
        [
          [
            init(),
            toolUse('agent', 'Agent', { description: 'Run the tests', prompt: 'Run them.' }),
            permission('test', 'Bash', TEST, 'All passed.', { parent: 'agent', agentId: 'ac2cfaf3' }),
            permission('lint', 'Bash', { command: 'npm run lint' }, 'Clean.', { parent: 'agent' }),
          ],
        ],
        decide,
      )
      played.session.send('Go', 'user-1')
      await flush()

      expect(calls.map(({ agentId }) => agentId)).toEqual(['ac2cfaf3'])
      const agentCall = played.events.find(
        (event) => event.kind === AgentEventKind.ToolCallStarted && event.name === 'Agent',
      )
      expect(played.events).toContainEqual(
        expect.objectContaining({
          kind: AgentEventKind.ToolCallStarted,
          name: 'Bash',
          parentToolUseId: (agentCall as { toolUseId: string }).toolUseId,
        }),
      )
      played.session.close()
    })

    it('makes up a subagent id for a nested call that gives none', async () => {
      const { calls, decide, give } = decider()
      const played = asking(
        [
          [
            init(),
            toolUse('agent', 'Agent', { prompt: 'Lint.' }),
            permission('lint', 'Bash', {}, 'Clean.', { parent: 'agent' }),
          ],
        ],
        decide,
      )
      played.session.send('Go', 'user-1')
      await flush()
      give({ behavior: ToolPermissionBehavior.Allow, byUser: true })
      await flush()

      expect(calls[0]?.agentId).toMatch(/^a.+agent$/)
      played.session.close()
    })

    it('stops asking once configure switches it to Allow all, even mid-turn', async () => {
      const { calls, decide, give } = decider()
      const played = asking(
        [
          [
            init(),
            permission('first', 'Bash', TEST, 'Ran.'),
            permission('second', 'Edit', { file_path: 'a.txt' }, 'Edited.'),
            result(),
          ],
        ],
        decide,
      )
      played.session.send('Go', 'user-1')
      await flush()

      played.session.configure({
        model: SESSION.model,
        effort: SESSION.effort,
        permissionMode: PermissionMode.AllowAll,
      })
      give({ behavior: ToolPermissionBehavior.Allow, byUser: true })
      await flush()

      expect(calls.map(({ toolName }) => toolName)).toEqual(['Bash'])
      expect(played.events.filter((event) => event.kind === AgentEventKind.ToolResult)).toHaveLength(2)
    })

    it('cancels the call on an interrupt, and ends the turn as interrupted during a tool', async () => {
      const { calls, decide, give } = decider()
      const played = asking([[init(), permission('test', 'Bash', TEST, 'Never.'), say('Never.')]], decide)
      played.session.send('Go', 'user-1')
      await flush()

      await played.session.interrupt()
      await flush()
      // The runner withdraws it; the answer comes too late to count.
      give({ behavior: ToolPermissionBehavior.Deny, message: 'Withdrawn.', byUser: false })
      await flush()

      expect(calls[0]?.signal.aborted).toBe(true)
      expect(played.events.slice(2)).toEqual([
        expect.objectContaining({ kind: AgentEventKind.ToolResult, output: REJECTED_TOOL_OUTPUT, isError: true }),
        expect.objectContaining({ kind: AgentEventKind.TurnFinished, terminalReason: 'aborted_tools' }),
      ])
    })

    it('denies the call when no one can be asked, as the SDK backend does', async () => {
      const played = play([[init(), permission('test', 'Bash', TEST, 'Never.'), result()]], {
        session: { ...SESSION, permissionMode: PermissionMode.AskBeforeEdits, mcpServers: { glade: gladeServer() } },
      })
      played.session.send('Go', 'user-1')
      await flush()

      expect(played.events).toContainEqual(
        expect.objectContaining({ kind: AgentEventKind.ToolResult, output: NO_ONE_TO_ASK, isError: true }),
      )
    })
  })

  it('passes an emit step’s message through as is', async () => {
    const played = play([[emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })]])
    played.session.send('Go', 'user-1')
    await flush()
    expect(played.raw).toEqual([{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }])
  })

  it('plays each message’s turn in order, replaying the last turn past the end', async () => {
    const played = play([
      [delay(100), say('One.'), result()],
      [say('Two.'), result()],
    ])
    played.session.send('a', 'user-1')
    played.session.send('b', 'user-2')
    played.session.send('c', 'user-3')
    await vi.advanceTimersByTimeAsync(100)
    const texts = played.raw.filter((message) => message.type === 'result').map((message) => message.result)
    expect(texts).toEqual(['One.', 'Two.', 'Two.'])
    expect(played.idles()).toBe(3)
  })

  it('folds a message sent mid-turn into the turn: it drops its steps left and plays the next turn’s instead', async () => {
    const played = play([
      [init(), say('Copying.'), ...tool('copy', 'Bash', { command: 'copy' }, 'copied'), delay(100), say('Never.')],
      [init(), say('Keeping the filenames.'), result()],
    ])
    played.session.send('Copy the files.', 'user-1')
    await flush()
    played.session.send('Keep the filenames.', 'user-2')
    expect(played.idles()).toBe(1)
    await vi.advanceTimersByTimeAsync(100)

    expect(played.raw.filter((message) => message.subtype === 'init')).toHaveLength(1)
    expect(played.events.filter((event) => event.kind === AgentEventKind.Text).map((event) => event.text)).toEqual([
      'Copying.',
      'Keeping the filenames.',
    ])
    expect(played.raw.at(-1)).toMatchObject({
      type: 'result',
      result: 'Keeping the filenames.',
      user_message_uuids: ['user-1', 'user-2'],
    })
    expect(played.idles()).toBe(2)
  })

  it('does not fold a message into an interrupted turn: it plays its own turn after', async () => {
    const played = play([[waitForInterrupt()], [say('Back.'), result()]])
    played.session.send('a', 'user-1')
    await flush()
    await played.session.interrupt()
    played.session.send('b', 'user-2')
    await flush()
    expect(played.raw.filter((message) => message.type === 'result').map((message) => message.result)).toEqual([
      '',
      'Back.',
    ])
  })

  it('runs the turns after a settings change on its model, as the SDK does', async () => {
    const played = play([[init(), say('Hi.'), result()]])
    played.session.send('a', 'user-1')
    played.session.configure({ model: 'claude-sample-2', effort: Effort.Low, permissionMode: PermissionMode.AllowAll })
    played.session.send('b', 'user-2')
    await flush()

    const models = played.raw
      .filter((message) => message.type === 'system' || message.type === 'assistant')
      .map((message) =>
        message.type === 'system' ? message.model : (message.message as Record<string, unknown>).model,
      )
    expect(models).toEqual(['claude-sample-1', 'claude-sample-1', 'claude-sample-2', 'claude-sample-2'])
  })

  it('plays the resume turn for the prompt Glade resumes a session with, and the next turn without one', async () => {
    const script: AgentScript = {
      name: 'test',
      turns: [[say('One.'), result()]],
      resumeTurn: [say('Again.'), result()],
    }
    const resumed = play([], { script })
    resumed.session.send(RESUME_PROMPT, 'resume-1')
    resumed.session.send('a', 'user-1')
    resumed.session.send(answeredAfterRestart({ kind: QuestionReplyKind.FreeText, text: 'By type.' }), 'answer-1')
    const plain = play([[say('One.'), result()]])
    plain.session.send(RESUME_PROMPT, 'resume-1')
    await flush()

    const results = ({ raw }: Played) =>
      raw.filter((message) => message.type === 'result').map((message) => message.result)
    expect(results(resumed)).toEqual(['Again.', 'One.', 'Again.'])
    expect(results(plain)).toEqual(['One.'])
  })

  it('reports the context each message used: 22,846 tokens, or as much of the window as a step fills', async () => {
    const played = play([[say('One.'), fillContext(0.97), say('Two.'), result()]], {
      session: { ...SESSION, model: 'claude-sample-1[1m]' },
    })
    played.session.send('a', 'user-1')
    await flush()
    expect(played.contextUsed).toEqual([22_846, 970_000])
  })

  it('compacts on /compact without using up a turn, and reports what it left from then on', async () => {
    const played = play([
      [fillContext(0.97), say('Full.'), result()],
      [say('After.'), result()],
    ])
    played.session.send('a', 'user-1')
    played.session.send(COMPACT_COMMAND, 'compact-1')
    played.session.send('b', 'user-2')
    await vi.advanceTimersByTimeAsync(1_000)

    expect(played.events.filter((event) => event.kind !== AgentEventKind.SessionStarted)).toEqual([
      expect.objectContaining({ kind: AgentEventKind.Text, text: 'Full.' }),
      expect.objectContaining({ kind: AgentEventKind.TurnFinished, result: 'Full.' }),
      { kind: AgentEventKind.Compacting },
      { kind: AgentEventKind.Compacted, trigger: CompactionTrigger.Manual, preTokens: 194_000, postTokens: 38_800 },
      expect.objectContaining({ kind: AgentEventKind.TurnFinished, result: '', userMessageUuids: ['compact-1'] }),
      expect.objectContaining({ kind: AgentEventKind.Text, text: 'After.' }),
      expect.objectContaining({ kind: AgentEventKind.TurnFinished, result: 'After.' }),
    ])
    expect(played.contextUsed).toEqual([194_000, 38_800])
    expect(played.warnings).toEqual([])
    expect(played.idles()).toBe(3)
  })

  it('compacts on its own in the middle of a turn, taking the time a compaction step gives it', async () => {
    const played = play([
      [fillContext(0.97), say('Full.'), compact({ trigger: 'auto', ms: 5_000 }), say('Carrying on.'), result()],
    ])
    played.session.send('Go', 'user-1')
    await vi.advanceTimersByTimeAsync(4_000)
    expect(played.events.at(-1)).toEqual({ kind: AgentEventKind.Compacting })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(played.events.filter((event) => event.kind !== AgentEventKind.SessionStarted)).toEqual([
      expect.objectContaining({ kind: AgentEventKind.Text, text: 'Full.' }),
      { kind: AgentEventKind.Compacting },
      { kind: AgentEventKind.Compacted, trigger: CompactionTrigger.Auto, preTokens: 194_000, postTokens: 38_800 },
      expect.objectContaining({ kind: AgentEventKind.Text, text: 'Carrying on.' }),
      expect.objectContaining({ kind: AgentEventKind.TurnFinished, result: 'Carrying on.' }),
    ])
    expect(played.contextUsed).toEqual([194_000, 38_800])
  })

  it("plays the script's own compact turn, and a compaction step's given count and trigger", async () => {
    const script: AgentScript = {
      name: 'test',
      turns: [[say('One.'), result()]],
      compactTurn: [compact({ postTokens: 41_000, trigger: 'auto' }), result({ text: '' })],
    }
    const played = play([], { script })
    played.session.send(COMPACT_COMMAND, 'compact-1')
    await flush()

    expect(played.events).toContainEqual({
      kind: AgentEventKind.Compacted,
      trigger: CompactionTrigger.Auto,
      preTokens: 22_846,
      postTokens: 41_000,
    })
  })

  it('plays nothing for a script with no turns', async () => {
    const played = play([])
    played.session.send('a', 'user-1')
    await flush()
    expect(played.raw).toEqual([])
    expect(played.idles()).toBe(1)
  })

  describe('interrupt', () => {
    it('cuts a delay short and ends the turn as aborted while streaming', async () => {
      const played = play([[say('Thinking.'), delay(60_000), say('Never.'), result()]])
      played.session.send('Go', 'user-1')
      await vi.advanceTimersByTimeAsync(2_000)
      await played.session.interrupt()
      await flush()

      expect(played.raw.slice(1)).toEqual([
        expect.objectContaining({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
        }),
        expect.objectContaining({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          terminal_reason: 'aborted_streaming',
          duration_ms: 2_000,
        }),
      ])
      expect(played.events.at(-1)).toMatchObject({ kind: AgentEventKind.TurnFinished, isError: true })
      expect(played.idles()).toBe(1)
    })

    it('rejects the calls still running, and says it was during a tool', async () => {
      const played = play([
        [toolUse('agent', 'Agent', {}), toolUse('bash', 'Bash', { command: 'sleep 99' }, 'agent'), waitForInterrupt()],
      ])
      played.session.send('Go', 'user-1')
      await flush()
      expect(played.idles()).toBe(1)

      await played.session.interrupt()
      await flush()
      expect(played.events.slice(3)).toEqual([
        {
          kind: AgentEventKind.ToolResult,
          toolUseId: 'toolu_id2_1_agent',
          output: REJECTED_TOOL_OUTPUT,
          isError: true,
          launched: false,
        },
        {
          kind: AgentEventKind.ToolResult,
          toolUseId: 'toolu_id2_1_bash',
          output: REJECTED_TOOL_OUTPUT,
          isError: true,
          launched: false,
        },
        expect.objectContaining({ kind: AgentEventKind.TurnFinished, terminalReason: 'aborted_tools' }),
      ])
      expect(played.raw).toContainEqual(
        expect.objectContaining({
          message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
        }),
      )
      expect(played.raw.filter((message) => message.parent_tool_use_id === 'toolu_id2_1_agent')).toHaveLength(2)
      // Idle once for the wait, not again when the turn ends.
      expect(played.idles()).toBe(1)
    })

    it('cuts a compaction short, leaving the context as it was', async () => {
      const played = play([
        [fillContext(0.97), say('Full.'), compact({ trigger: 'auto', ms: 60_000 }), say('Never.'), result()],
      ])
      played.session.send('Go', 'user-1')
      await vi.advanceTimersByTimeAsync(2_000)
      expect(played.events.at(-1)).toEqual({ kind: AgentEventKind.Compacting })

      await played.session.interrupt()
      await flush()
      expect(played.events.map((event) => event.kind)).not.toContain(AgentEventKind.Compacted)
      expect(played.events.at(-1)).toMatchObject({ kind: AgentEventKind.TurnFinished, isError: true })
      expect(played.contextUsed).toEqual([194_000])
    })

    it('does nothing between turns', async () => {
      const played = play([[result()]])
      await played.session.interrupt()
      played.session.send('Go', 'user-1')
      await flush()
      expect(played.raw.map((message) => message.subtype)).toEqual(['success'])
    })

    it('lets the next turn play after an interrupted one', async () => {
      const played = play([[waitForInterrupt()], [say('Back.'), result()]])
      played.session.send('a', 'user-1')
      played.session.send('b', 'user-2')
      await flush()
      await played.session.interrupt()
      await flush()
      expect(played.raw.filter((message) => message.type === 'result').map((message) => message.result)).toEqual([
        '',
        'Back.',
      ])
    })
  })

  it('dies at a fail step: the stream throws, and nothing more plays', async () => {
    const played = play([[say('Starting.'), fail('The agent process exited with code 1'), say('Never.')]])
    played.session.send('Go', 'user-1')
    played.session.send('Again', 'user-2')
    await flush()

    expect((await played.ended)?.message).toBe('The agent process exited with code 1')
    expect(played.events).toEqual([{ kind: AgentEventKind.Text, text: 'Starting.', parentToolUseId: null }])
    expect(played.idles()).toBe(2)
  })

  it('ends the stream on close, without playing out or aborting the turn', async () => {
    const played = play([[say('Starting.'), delay(1_000), say('Never.')], [say('Nor this.')]])
    played.session.send('Go', 'user-1')
    await flush()
    played.session.close()
    played.session.send('Again', 'user-2')
    await vi.advanceTimersByTimeAsync(1_000)

    expect(await played.ended).toBeNull()
    expect(played.events).toEqual([{ kind: AgentEventKind.Text, text: 'Starting.', parentToolUseId: null }])
    expect(played.idles()).toBe(2)
  })

  describe('a turn the agent starts on its own', () => {
    /** A turn that starts a build in the background, and wakes `ms` later to report on it. */
    function backgroundBuild(ms?: number, then: ScriptTurn = [init(), say('Built.'), result()]): ScriptTurn {
      return [
        init(),
        ...tool('build', 'Bash', { command: 'npm run build', run_in_background: true }, 'Running in background.'),
        wake(then, {
          task: 'build',
          summary: 'Background command "Build" completed',
          ...(ms === undefined ? {} : { ms }),
        }),
        say('Started.'),
        result(),
      ]
    }

    it('plays after the turn ends, as the SDK streams it: the notification, then a turn answering no message', async () => {
      let wakes = 0
      const played = play([backgroundBuild()], { onWake: () => (wakes += 1) })
      played.session.send('Build it.', 'user-1')
      await flush()

      const [first, woken] = played.raw.filter((message) => message.type === 'result')
      expect(first).toMatchObject({ result: 'Started.', user_message_uuids: ['user-1'] })
      expect(first).not.toHaveProperty('origin')
      const afterFirst = played.raw.slice(played.raw.indexOf(first ?? {}) + 1)
      const buildId = played.raw.find((message) => message.type === 'assistant')?.message as {
        content: { id: string }[]
      }
      expect(afterFirst.map((message) => message.subtype ?? message.type)).toEqual([
        'task_updated',
        'task_notification',
        'init',
        'assistant',
        'success',
      ])
      expect(afterFirst[1]).toMatchObject({
        tool_use_id: buildId.content[0]?.id,
        status: 'completed',
        summary: 'Background command "Build" completed',
      })
      expect(afterFirst[3]).not.toHaveProperty('user_message_uuid')
      expect(woken).toMatchObject({ result: 'Built.', origin: { kind: 'task-notification' } })
      expect(woken).not.toHaveProperty('user_message_uuids')
      expect(wakes).toBe(1)
      expect(played.idles()).toBe(2)
    })

    it('waits the time it is given, and gives its ids a key of their own', async () => {
      const again: ScriptTurn = [init(), ...tool('build', 'Bash', { command: 'cat out' }, 'ok'), result()]
      const played = play([backgroundBuild(500, again)])
      played.session.send('Build it.', 'user-1')
      await flush()
      expect(played.raw.filter((message) => message.type === 'result')).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(500)
      const calls = played.events.flatMap((event) =>
        event.kind === AgentEventKind.ToolCallStarted ? [event.toolUseId] : [],
      )
      expect(calls).toHaveLength(2)
      expect(new Set(calls).size).toBe(2)
      expect(played.idles()).toBe(2)
    })

    it('says no task finished for a wakeup that was not a background task', async () => {
      const played = play([
        [init(), wake([init(), say('Time to check.'), result()], { summary: 'Timer fired' }), result()],
      ])
      played.session.send('Check back later.', 'user-1')
      await flush()

      expect(played.raw.find((message) => message.subtype === 'task_notification')).not.toHaveProperty('tool_use_id')
    })

    it('folds in a message sent while it plays, and its result lists it', async () => {
      const played = play([
        backgroundBuild(0, [init(), say('Checking the output.'), delay(100), say('Never.')]),
        [say('Publishing it.'), result()],
      ])
      played.session.send('Build it.', 'user-1')
      await flush()
      played.session.send('Publish it.', 'user-2')
      await vi.advanceTimersByTimeAsync(100)

      expect(played.raw.at(-1)).toMatchObject({
        type: 'result',
        result: 'Publishing it.',
        origin: { kind: 'task-notification' },
        user_message_uuids: ['user-2'],
      })
    })

    it('waits for the turn a message started meanwhile to end', async () => {
      const played = play([backgroundBuild(10), [say('Still going.'), delay(100), result()]])
      played.session.send('Build it.', 'user-1')
      await flush()
      played.session.send('How is it going?', 'user-2')
      await vi.advanceTimersByTimeAsync(100)

      expect(played.raw.filter((message) => message.type === 'result').map((message) => message.result)).toEqual([
        'Started.',
        'Still going.',
        'Built.',
      ])
    })

    it('plays nothing once the session is closed, but still goes idle', async () => {
      const played = play([backgroundBuild(100)])
      played.session.send('Build it.', 'user-1')
      await flush()
      played.session.close()
      await vi.advanceTimersByTimeAsync(100)

      expect(played.raw.filter((message) => message.subtype === 'task_notification')).toEqual([])
      expect(played.idles()).toBe(2)
    })
  })

  describe('a subagent in the background', () => {
    const AGENT_INPUT = { description: 'Profile the queries', prompt: 'Time them.', subagent_type: 'general-purpose' }

    /** A turn that starts a subagent in the background, which reads a file, waits `ms` and ends as `options` say. */
    function launch(ms: number, options: Partial<Parameters<typeof background>[3]> = {}): ScriptTurn {
      return [
        init(),
        background(
          'agent',
          AGENT_INPUT,
          [
            say('Timing them.', 'agent'),
            ...tool('read', 'Read', { file_path: 'queries.py' }, 'def load_cart(): …', 'agent'),
            toolUse('time', 'Bash', { command: 'python time.py' }, 'agent'),
            delay(ms),
            toolResult('time', '38 queries'),
          ],
          { summary: 'An N+1 in load_cart.', ...options },
        ),
        say('Started it.'),
        result(),
      ]
    }

    function kinds(raw: readonly Record<string, unknown>[]): unknown[] {
      return raw.map((message) => message.subtype ?? message.type)
    }

    it('launches it as the SDK does, and the turn ends while it plays on, then notifies and wakes the agent', async () => {
      let wakes = 0
      const played = play([launch(100, { turn: [init(), say('The profile is back.'), result()] })], {
        onWake: () => (wakes += 1),
      })
      played.session.send('Profile checkout.', 'user-1')
      await flush()

      const agentId = 'toolu_id2_1_agent'
      expect(played.raw.slice(1, 4)).toEqual([
        expect.objectContaining({
          type: 'assistant',
          message: expect.objectContaining({
            content: [
              { type: 'tool_use', id: agentId, name: 'Agent', input: { ...AGENT_INPUT, run_in_background: true } },
            ],
          }) as unknown,
        }),
        expect.objectContaining({
          subtype: 'task_started',
          task_id: 'aid21',
          tool_use_id: agentId,
          description: 'Profile the queries',
          is_backgrounded: true,
          task_type: 'local_agent',
        }),
        expect.objectContaining({
          type: 'user',
          tool_use_result: expect.objectContaining({ isAsync: true, status: 'async_launched' }) as unknown,
        }),
      ])
      expect(played.events).toContainEqual({
        kind: AgentEventKind.ToolResult,
        toolUseId: agentId,
        output: LAUNCHED_OUTPUT,
        isError: false,
        launched: true,
      })
      // The turn has ended while the subagent plays on.
      expect(played.raw.find((message) => message.type === 'result')).toMatchObject({ result: 'Started it.' })
      expect(played.idles()).toBe(1)
      expect(wakes).toBe(1)

      await vi.advanceTimersByTimeAsync(100)
      const afterResult = played.raw.slice(played.raw.findIndex((message) => message.type === 'result') + 1)
      expect(kinds(afterResult)).toEqual([
        'assistant',
        'task_progress',
        'user',
        'task_updated',
        'task_notification',
        'init',
        'assistant',
        'success',
      ])
      const progress = played.raw.filter((message) => message.subtype === 'task_progress')
      expect(progress).toEqual([
        expect.objectContaining({ task_id: 'aid21', tool_use_id: agentId, last_tool_name: 'Read' }),
        expect.objectContaining({
          usage: expect.objectContaining({ tool_uses: 2 }) as unknown,
          last_tool_name: 'Bash',
        }),
      ])
      expect(played.raw.find((message) => message.subtype === 'task_notification')).toMatchObject({
        tool_use_id: agentId,
        status: 'completed',
        summary: 'An N+1 in load_cart.',
        usage: { tool_uses: 2, duration_ms: 100 },
      })
      expect(played.raw.at(-1)).toMatchObject({ result: 'The profile is back.', origin: { kind: 'task-notification' } })
      // Its calls are the subagent's, and its messages apart from the turn's.
      const subagentCalls = played.events.filter(
        (event) => event.kind === AgentEventKind.ToolCallStarted && event.parentToolUseId === agentId,
      )
      expect(subagentCalls).toHaveLength(2)
      const messageIds = played.raw
        .filter((message) => message.type === 'assistant')
        .map((message) => (message.message as { id: string }).id)
      // Two for the turn, two for the subagent (a new one after each round of results), one for the turn it woke.
      expect(messageIds).toHaveLength(6)
      expect(new Set(messageIds).size).toBe(5)
      expect(played.idles()).toBe(2)
    })

    it('fails as the script says, and with no turn to play, only goes idle', async () => {
      const played = play([launch(10, { outcome: 'failed', summary: 'Connection refused.' })])
      played.session.send('Profile checkout.', 'user-1')
      await vi.advanceTimersByTimeAsync(10)

      expect(played.raw.find((message) => message.subtype === 'task_updated')).toMatchObject({
        patch: { status: 'failed' },
      })
      expect(played.raw.at(-1)).toMatchObject({ subtype: 'task_notification', status: 'failed' })
      expect(played.raw.filter((message) => message.type === 'result')).toHaveLength(1)
      expect(played.idles()).toBe(2)
    })

    it('is stopped by its task id, as the SDK stops one, then plays its stopped turn', async () => {
      const played = play([
        launch(60_000, {
          turn: [init(), say('Never.'), result()],
          stoppedTurn: [init(), say('The profile was stopped.'), result()],
        }),
      ])
      played.session.send('Profile checkout.', 'user-1')
      await flush()

      await played.session.stopTask('nothing-like-it')
      await flush()
      expect(played.raw.filter((message) => message.subtype === 'task_notification')).toEqual([])

      await played.session.stopTask('aid21')
      await flush()
      const notification = played.raw.findIndex((message) => message.subtype === 'task_notification')
      expect(played.raw[notification - 1]).toMatchObject({ subtype: 'task_updated', patch: { status: 'killed' } })
      expect(played.raw[notification]).toMatchObject({ status: 'stopped', summary: 'Profile the queries' })
      expect(played.raw[notification + 1]).toMatchObject({
        parent_tool_use_id: 'toolu_id2_1_agent',
        message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      })
      expect(played.raw.at(-1)).toMatchObject({ result: 'The profile was stopped.' })
      // The call it was in never gets a result.
      expect(played.events).not.toContainEqual(expect.objectContaining({ output: '38 queries' }))
      expect(played.idles()).toBe(2)
    })

    it('stops without a word when the session closes, but still goes idle', async () => {
      const played = play([launch(60_000, { turn: [init(), say('Never.'), result()] })])
      played.session.send('Profile checkout.', 'user-1')
      await flush()
      played.session.close()
      await flush()

      expect(played.raw.filter((message) => message.subtype === 'task_notification')).toEqual([])
      expect(played.idles()).toBe(2)
    })

    it('kills the session at a fail step, as a turn does', async () => {
      const played = play([
        [init(), background('agent', AGENT_INPUT, [delay(10), fail('The agent crashed.')], { summary: '' }), result()],
      ])
      played.session.send('Profile checkout.', 'user-1')
      await vi.advanceTimersByTimeAsync(10)

      expect(await played.ended).toEqual(new Error('The agent crashed.'))
      expect(played.idles()).toBe(2)
    })

    it('kills the session, loudly, when one of its Glade tools cannot be called', async () => {
      const played = play(
        [
          [
            init(),
            background('agent', AGENT_INPUT, [gladeTool('title', 'set_title', { title: 'X' })], { summary: '' }),
          ],
        ],
        { session: SESSION },
      )
      played.session.send('Profile checkout.', 'user-1')
      await flush()

      expect(await played.ended).toBeInstanceOf(Error)
    })
  })
})
