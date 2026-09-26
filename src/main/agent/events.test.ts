import { describe, expect, it, vi } from 'vitest'
import { CompactionTrigger } from '../../shared/domain'
import { AgentEventKind, createSdkMessageParser, RateLimitStatus, TaskOutcome, type AgentEvent } from './events'
import * as sdk from './test-sdk-messages'

function parser() {
  const warn = vi.fn()
  return { parse: createSdkMessageParser({ warn }), warn }
}

function parse(raw: unknown): AgentEvent[] {
  return parser().parse(raw)
}

function isRateLimit(message: unknown): boolean {
  return typeof message === 'object' && message !== null && Reflect.get(message, 'type') === 'rate_limit_event'
}

describe('parsing SDK messages', () => {
  it('reads the session id and model from system/init', () => {
    expect(parse(sdk.init())).toEqual([
      { kind: AgentEventKind.SessionStarted, sessionId: sdk.SESSION_ID, model: sdk.MODEL },
    ])
  })

  it("reads the agent's text and tool calls, at the top level and in a subagent", () => {
    expect(parse(sdk.text('Checking the tests.'))).toEqual([
      { kind: AgentEventKind.ContextUsed, tokens: sdk.CONTEXT_USED },
      { kind: AgentEventKind.Text, text: 'Checking the tests.', parentToolUseId: null },
    ])
    expect(parse(sdk.toolUse('toolu_03', 'Bash', { command: 'ls' }, 'toolu_02'))).toEqual([
      {
        kind: AgentEventKind.ToolCallStarted,
        toolUseId: 'toolu_03',
        name: 'Bash',
        input: { command: 'ls' },
        parentToolUseId: 'toolu_02',
      },
    ])
  })

  it("reads how full the context is from a top-level message's input tokens, not a subagent's", () => {
    expect(sdk.CONTEXT_USED).toBe(10 + 1272 + 21564)
    expect(parse(sdk.withContextUsed(sdk.thinking(), 76_000))).toEqual([
      { kind: AgentEventKind.ContextUsed, tokens: 76_000 },
    ])
    expect(parse(sdk.thinking()).map((event) => event.kind)).toEqual([AgentEventKind.ContextUsed])
    expect(parse(sdk.text('Inside.', 'toolu_02')).map((event) => event.kind)).toEqual([AgentEventKind.Text])
  })

  it('reads a message with no usage, or a malformed one, as its content alone', () => {
    const content = [{ type: 'text', text: 'Hi.' }]
    const noUsage = { type: 'assistant', message: { content } }
    const badUsage = { type: 'assistant', message: { content, usage: 'lots' } }
    const partUsage = { type: 'assistant', message: { content: [], usage: { input_tokens: 5, output_tokens: 'x' } } }
    const { parse: parseQuietly, warn } = parser()

    expect(parseQuietly(noUsage)).toEqual([{ kind: AgentEventKind.Text, text: 'Hi.', parentToolUseId: null }])
    expect(parseQuietly(badUsage)).toEqual([{ kind: AgentEventKind.Text, text: 'Hi.', parentToolUseId: null }])
    expect(parseQuietly(partUsage)).toEqual([{ kind: AgentEventKind.ContextUsed, tokens: 5 }])
    expect(warn).not.toHaveBeenCalled()
  })

  it('reads every block of an assistant message, skipping thinking and a missing parent', () => {
    const message = {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'Hmm.' },
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: 'a.ts' } },
        ],
      },
    }
    expect(parse(message)).toEqual([
      { kind: AgentEventKind.Text, text: 'Let me look.', parentToolUseId: null },
      {
        kind: AgentEventKind.ToolCallStarted,
        toolUseId: 'toolu_01',
        name: 'Read',
        input: { file_path: 'a.ts' },
        parentToolUseId: null,
      },
    ])
  })

  it('reads tool results with string content, text blocks or none', () => {
    expect(parse(sdk.toolResult('toolu_01', '12 passed'))).toEqual([
      {
        kind: AgentEventKind.ToolResult,
        toolUseId: 'toolu_01',
        output: '12 passed',
        isError: false,
        launched: false,
        details: { stdout: '12 passed', stderr: '', interrupted: false },
      },
    ])
    const blocks = [
      { type: 'text', text: 'Line one.' },
      { type: 'image', source: {} },
      { type: 'text', text: 'Line two.' },
    ]
    expect(parse(sdk.toolResult('toolu_02', blocks, true))).toEqual([
      {
        kind: AgentEventKind.ToolResult,
        toolUseId: 'toolu_02',
        output: 'Line one.\nLine two.',
        isError: true,
        launched: false,
        details: { stdout: '', stderr: '', interrupted: false },
      },
    ])
    const bare = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_03' }] } }
    expect(parse(bare)).toEqual([
      {
        kind: AgentEventKind.ToolResult,
        toolUseId: 'toolu_03',
        output: '',
        isError: false,
        launched: false,
        details: null,
      },
    ])
  })

  it('reads nothing from user messages that hold no tool results, or replay earlier ones', () => {
    expect(parse({ type: 'user', message: { content: 'This session is being continued…' } })).toEqual([])
    expect(parse({ type: 'user', message: { content: [{ type: 'text', text: 'Subagent prompt' }] } })).toEqual([])
    expect(parse({ ...(sdk.toolResult('toolu_01', 'x') as object), isReplay: true })).toEqual([])
    // setModel's echo (docs/sdk-notes.md §4) stays out of the chat.
    const echo = '<local-command-stdout>Set model to claude-sonnet-5</local-command-stdout>'
    expect(parse({ type: 'user', message: { content: echo } })).toEqual([])
  })

  it('reads a compaction from its status and boundary, and nothing from the messages around it', () => {
    expect(sdk.compaction(198_000, 41_000).flatMap((message) => parse(message))).toEqual([
      { kind: AgentEventKind.Compacting },
      { kind: AgentEventKind.Compacted, trigger: CompactionTrigger.Manual, preTokens: 198_000, postTokens: 41_000 },
    ])
    expect(parse(sdk.compactBoundary({ trigger: 'auto', pre_tokens: 167_500, post_tokens: 30_000 }))).toEqual([
      { kind: AgentEventKind.Compacted, trigger: CompactionTrigger.Auto, preTokens: 167_500, postTokens: 30_000 },
    ])
  })

  it('reads a compaction without a usable post-compaction count as one whose count is unknown', () => {
    const { parse: parseQuietly, warn } = parser()
    expect(parseQuietly(sdk.compactBoundary({ trigger: 'manual', pre_tokens: 198_000 }))).toEqual([
      { kind: AgentEventKind.Compacted, trigger: CompactionTrigger.Manual, preTokens: 198_000, postTokens: null },
    ])
    expect(parseQuietly(sdk.compactBoundary({ trigger: 'manual', pre_tokens: 198_000, post_tokens: -1 }))).toEqual([
      expect.objectContaining({ postTokens: null }),
    ])
    expect(warn).not.toHaveBeenCalled()
  })

  it('reads a successful result with its usage, duration and cost', () => {
    expect(parse(sdk.result('Done.'))).toEqual([
      {
        kind: AgentEventKind.TurnFinished,
        isError: false,
        result: 'Done.',
        errors: [],
        terminalReason: 'completed',
        durationMs: 7620,
        totalCostUsd: 0.0285,
        usage: { inputTokens: 28, outputTokens: 553, cacheReadInputTokens: 58094, cacheCreationInputTokens: 9443 },
        contextWindows: { [sdk.MODEL]: sdk.CONTEXT_WINDOW },
        userMessageUuids: null,
        apiErrorStatus: null,
        startupFailureReason: null,
      },
    ])
  })

  it('reads the user messages a result answered, when it says', () => {
    expect(parse(sdk.result('Done.', { user_message_uuids: ['m1', 'm2'] }))).toEqual([
      expect.objectContaining({ userMessageUuids: ['m1', 'm2'] }),
    ])
    expect(parse(sdk.result('Done.', { user_message_uuids: 'm1' }))).toEqual([
      expect.objectContaining({ userMessageUuids: null }),
    ])
  })

  it("reads each model's context window from a result, skipping entries without one", () => {
    const modelUsage = {
      'claude-sample-1[1m]': { contextWindow: 1_000_000, inputTokens: 1 },
      'claude-sample-2': { contextWindow: 200_000 },
      'claude-sample-3': { inputTokens: 1 },
      'claude-sample-4': 'n/a',
    }
    expect(parse(sdk.result('Done.', { modelUsage }))).toEqual([
      expect.objectContaining({
        contextWindows: { 'claude-sample-1[1m]': 1_000_000, 'claude-sample-2': 200_000 },
      }),
    ])
  })

  it('reads an error result by its error flag, not its subtype, with its API error status', () => {
    expect(parse(sdk.apiErrorResult())).toEqual([
      expect.objectContaining({
        kind: AgentEventKind.TurnFinished,
        isError: true,
        result: sdk.OVERLOADED_ERROR,
        terminalReason: 'api_error',
        apiErrorStatus: 529,
        startupFailureReason: null,
      }),
    ])
    expect(parse(sdk.result('', { api_error_status: 'n/a' }))).toEqual([
      expect.objectContaining({ apiErrorStatus: null }),
    ])
  })

  it('reads why Claude Code could not start from its zeroed result, and a malformed reason as none', () => {
    expect(parse(sdk.startupFailureResult('cwd_unavailable', 'Error: the folder /code/gone does not exist'))).toEqual([
      expect.objectContaining({
        kind: AgentEventKind.TurnFinished,
        isError: true,
        errors: ['Error: the folder /code/gone does not exist'],
        startupFailureReason: 'cwd_unavailable',
      }),
    ])
    expect(parse(sdk.result('', { is_error: true, startup_failure_reason: 42 }))).toEqual([
      expect.objectContaining({ startupFailureReason: null }),
    ])
  })

  it('reads the notice of a retried API request', () => {
    expect(parse(sdk.apiRetry(2, 10))).toEqual([
      { kind: AgentEventKind.ApiRetry, attempt: 2, maxRetries: 10, delayMs: 1000, status: 529, code: 'overloaded' },
    ])
    const connection = { ...(sdk.apiRetry(1) as object), error_status: null, error: 'unknown', retry_delay_ms: 'x' }
    expect(parse(connection)).toEqual([expect.objectContaining({ status: null, code: 'unknown', delayMs: 0 })])
  })

  it("reads where the usage limit stands, with its reset time in milliseconds when it's given", () => {
    expect(parse(sdk.rateLimit('rejected', 1_790_000_000))).toEqual([
      { kind: AgentEventKind.RateLimit, status: RateLimitStatus.Rejected, resetsAt: 1_790_000_000_000 },
    ])
    expect(parse(sdk.turnStartNoise().find(isRateLimit))).toEqual([
      { kind: AgentEventKind.RateLimit, status: RateLimitStatus.Allowed, resetsAt: null },
    ])
    const malformed = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 'soon' } }
    expect(parse(malformed)).toEqual([
      { kind: AgentEventKind.RateLimit, status: RateLimitStatus.AllowedWarning, resetsAt: null },
    ])
  })

  it('reads the message an API error makes as the error, not as text or context used', () => {
    expect(parse(sdk.apiErrorMessage('overloaded'))).toEqual([
      { kind: AgentEventKind.ApiError, code: 'overloaded', message: sdk.OVERLOADED_ERROR },
    ])
    // A subagent's failed request is its own business.
    expect(parse(sdk.apiErrorMessage('overloaded', sdk.OVERLOADED_ERROR, 'toolu_agent'))).toEqual([])
  })

  it('reads a result with fields missing or malformed as a failed turn with what it could read', () => {
    expect(parse({ type: 'result', usage: { input_tokens: 'many' }, errors: 'nope' })).toEqual([
      {
        kind: AgentEventKind.TurnFinished,
        isError: true,
        result: '',
        errors: [],
        terminalReason: null,
        durationMs: null,
        totalCostUsd: null,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        contextWindows: {},
        userMessageUuids: null,
        apiErrorStatus: null,
        startupFailureReason: null,
      },
    ])
  })

  it('drops the message types and system subtypes Glade does not use, without a word', () => {
    const { parse: parseQuietly, warn } = parser()
    for (const message of [
      ...sdk.turnStartNoise().filter((message) => !isRateLimit(message)),
      { type: 'stream_event', event: {} },
      { type: 'tool_progress', elapsed_time_seconds: 3 },
      { type: 'system', subtype: 'status', status: 'requesting' },
      { type: 'system', subtype: 'status', status: null, compact_result: 'success' },
      { type: 'system', subtype: 'status' },
    ]) {
      expect(parseQuietly(message)).toEqual([])
    }
    expect(warn).not.toHaveBeenCalled()
  })

  it('reads a subagent started as a task, by the tool call that started it', () => {
    expect(parse({ type: 'system', subtype: 'task_started', task_id: 'b7f3', tool_use_id: 'toolu_02' })).toEqual([
      {
        kind: AgentEventKind.SubagentStarted,
        sdkTaskId: 'b7f3',
        toolUseId: 'toolu_02',
        background: false,
        taskType: null,
        isBackgrounded: false,
        description: '',
      },
    ])
    // A task no tool call started has no row to stop it from.
    expect(parse({ type: 'system', subtype: 'task_started', task_id: 'b7f4' })).toEqual([])
    const { parse: parseLogged, warn } = parser()
    expect(parseLogged({ type: 'system', subtype: 'task_started' })).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
  })

  it('reads a subagent started in the background, its launched result, and its move to the background', () => {
    const [call, started, launched] = sdk.backgroundLaunch('toolu_q', 'aq1', 'Profile the checkout queries')
    expect(parse(call)).toContainEqual(expect.objectContaining({ kind: AgentEventKind.ToolCallStarted, name: 'Agent' }))
    expect(parse(started)).toEqual([
      {
        kind: AgentEventKind.SubagentStarted,
        sdkTaskId: 'aq1',
        toolUseId: 'toolu_q',
        background: true,
        taskType: 'local_agent',
        isBackgrounded: true,
        description: 'Profile the checkout queries',
      },
    ])
    expect(parse(launched)).toEqual([
      {
        kind: AgentEventKind.ToolResult,
        toolUseId: 'toolu_q',
        output: 'Async agent launched.',
        isError: false,
        launched: true,
        details: expect.objectContaining({ status: 'async_launched' }) as unknown,
      },
    ])
    // A background command isn't a subagent: its call's result is its own.
    const command = { type: 'system', subtype: 'task_started', task_id: 'b88t', tool_use_id: 'toolu_01' }
    const commandStarted = {
      kind: AgentEventKind.SubagentStarted,
      sdkTaskId: 'b88t',
      toolUseId: 'toolu_01',
      background: false,
    }
    expect(parse({ ...command, task_type: 'local_bash', is_backgrounded: true, description: 'Run the suite' })).toEqual(
      [{ ...commandStarted, taskType: 'local_bash', isBackgrounded: true, description: 'Run the suite' }],
    )
    // A foreground command's task: its call waits on it (docs/sdk-notes.md, "Background work inside a subagent").
    expect(
      parse({ ...command, task_type: 'local_bash', is_backgrounded: false, owned_by_subagent: true, description: 'x' }),
    ).toEqual([{ ...commandStarted, taskType: 'local_bash', isBackgrounded: false, description: 'x' }])
    expect(parse({ ...command, task_type: 42, is_backgrounded: 'yes', description: 7 })).toEqual([
      { ...commandStarted, taskType: null, isBackgrounded: false, description: '' },
    ])

    const updated = { type: 'system', subtype: 'task_updated', task_id: 'af1' }
    expect(parse({ ...updated, patch: { is_backgrounded: true } })).toEqual([
      { kind: AgentEventKind.SubagentBackgrounded, sdkTaskId: 'af1' },
    ])
    expect(parse({ ...updated, patch: { status: 'completed', end_time: 1 } })).toEqual([])
    const { parse: parseLogged, warn } = parser()
    expect(parseLogged({ type: 'system', subtype: 'task_updated', task_id: 'af1' })).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
  })

  it('reads a task ending, by the tool call that started it', () => {
    const [, notification] = sdk.subagentEnded('toolu_q', 'aq1', 'failed', 'Connection refused.')
    expect(parse(notification)).toEqual([
      {
        kind: AgentEventKind.TaskFinished,
        sdkTaskId: 'aq1',
        toolUseId: 'toolu_q',
        outcome: TaskOutcome.Failed,
        summary: 'Connection refused.',
      },
    ])
    const bare = { type: 'system', subtype: 'task_notification', task_id: 'aq1', status: 'stopped' }
    expect(parse({ ...bare, tool_use_id: 'toolu_q' })).toEqual([
      {
        kind: AgentEventKind.TaskFinished,
        sdkTaskId: 'aq1',
        toolUseId: 'toolu_q',
        outcome: TaskOutcome.Stopped,
        summary: '',
      },
    ])
    // A task no tool call started has no row to end.
    expect(parse(bare)).toEqual([])
    const { parse: parseLogged, warn } = parser()
    expect(parseLogged({ ...bare, status: 'exploded' })).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
  })

  it('reads a compaction starting, and one failing, from the session status', () => {
    expect(parse({ type: 'system', subtype: 'status', status: 'compacting' })).toEqual([
      { kind: AgentEventKind.Compacting },
    ])
    expect(
      parse({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'Too long' }),
    ).toEqual([{ kind: AgentEventKind.CompactionFailed }])
  })

  it('drops an unknown message type, logging it once', () => {
    const { parse: parseOnce, warn } = parser()

    expect(parseOnce({ type: 'hologram', session_id: 'x' })).toEqual([])
    expect(parseOnce({ type: 'hologram', session_id: 'y' })).toEqual([])

    expect(warn).toHaveBeenCalledExactlyOnceWith('Ignored SDK messages of the unknown type hologram')
  })

  it.each([
    ['a non-object', 'hello', 'Dropped an SDK message with no type'],
    ['null', null, 'Dropped an SDK message with no type'],
    ['a message with no type', { subtype: 'init' }, 'Dropped an SDK message with no type'],
    ['an init with no session id', { type: 'system', subtype: 'init', model: 'm' }, 'system/init'],
    ['an API retry with no attempt', { type: 'system', subtype: 'api_retry', max_retries: 3 }, 'system/api_retry'],
    [
      'a rate limit with an unknown status',
      { type: 'rate_limit_event', rate_limit_info: { status: 'x' } },
      'rate_limit',
    ],
    ['an assistant message with no content', { type: 'assistant', message: {} }, 'assistant'],
    ['a user message with no message', { type: 'user' }, 'user'],
    ['a compact boundary with no metadata', { type: 'system', subtype: 'compact_boundary' }, 'system/compact_boundary'],
    [
      'a compact boundary with an unknown trigger',
      sdk.compactBoundary({ trigger: 'sometimes', pre_tokens: 1 }),
      'system/compact_boundary',
    ],
  ])('drops %s, logging why', (_case, raw, logged) => {
    const { parse: parseBad, warn } = parser()

    expect(parseBad(raw)).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain(logged)
  })

  it.each([
    ['text block', { type: 'text', text: 42 }, 'Dropped a malformed text block from the agent'],
    ['tool call', { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: 'ls' }, 'Dropped a malformed tool call'],
  ])('drops a malformed %s but keeps the blocks around it', (_case, bad, logged) => {
    const { parse: parseBad, warn } = parser()
    const message = { type: 'assistant', message: { content: [bad, { type: 'text', text: 'Still here.' }] } }

    expect(parseBad(message)).toEqual([{ kind: AgentEventKind.Text, text: 'Still here.', parentToolUseId: null }])
    expect(warn.mock.calls[0]?.[0]).toContain(logged)
  })

  it('drops a malformed tool result', () => {
    const { parse: parseBad, warn } = parser()
    const message = { type: 'user', message: { content: [{ type: 'tool_result', content: 'no id' }] } }

    expect(parseBad(message)).toEqual([])
    expect(warn.mock.calls[0]?.[0]).toBe('Dropped a malformed tool result')
  })
})
