import { createSdkMcpServer, tool as mcpTool } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CompactionTrigger, Effort, QuestionKind, QuestionReplyKind } from '../../shared/domain'
import type { AgentSessionOptions } from './backend'
import { AgentEventKind, createSdkMessageParser, type AgentEvent } from './events'
import { answeredAfterRestart, COMPACT_COMMAND, RESUME_PROMPT } from './runner'
import { gladeToolName, REJECTED_TOOL_OUTPUT, ScriptedSession, type ScriptedSessionOptions } from './scripted-session'
import {
  ask,
  compact,
  delay,
  emit,
  fail,
  fillContext,
  gladeTool,
  init,
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
      { kind: AgentEventKind.ToolResult, toolUseId: `${prefix}read`, output: 'contents', isError: false },
      {
        kind: AgentEventKind.ToolCallStarted,
        toolUseId: `${prefix}agent`,
        name: 'Agent',
        input: { description: 'Look' },
        parentToolUseId: null,
      },
      {
        kind: AgentEventKind.ToolCallStarted,
        toolUseId: `${prefix}inner`,
        name: 'Grep',
        input: { pattern: 'x' },
        parentToolUseId: `${prefix}agent`,
      },
      { kind: AgentEventKind.ToolResult, toolUseId: `${prefix}inner`, output: 'hit', isError: false },
      { kind: AgentEventKind.Text, text: 'Subagent text', parentToolUseId: `${prefix}agent` },
      { kind: AgentEventKind.ToolResult, toolUseId: `${prefix}agent`, output: 'Found it.', isError: false },
      { kind: AgentEventKind.ToolResult, toolUseId: `${prefix}never-called`, output: 'orphan', isError: true },
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
    played.session.configure({ model: 'claude-sample-2', effort: Effort.Low })
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
      expect(played.events.slice(2)).toEqual([
        {
          kind: AgentEventKind.ToolResult,
          toolUseId: 'toolu_id2_1_agent',
          output: REJECTED_TOOL_OUTPUT,
          isError: true,
        },
        { kind: AgentEventKind.ToolResult, toolUseId: 'toolu_id2_1_bash', output: REJECTED_TOOL_OUTPUT, isError: true },
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
})
