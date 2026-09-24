import { describe, expect, it, vi } from 'vitest'
import { CompactionTrigger } from '../../shared/domain'
import { AgentEventKind, createSdkMessageParser, type AgentEvent } from './events'
import * as sdk from './test-sdk-messages'

function parser() {
  const warn = vi.fn()
  return { parse: createSdkMessageParser({ warn }), warn }
}

function parse(raw: unknown): AgentEvent[] {
  return parser().parse(raw)
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
      { kind: AgentEventKind.ToolResult, toolUseId: 'toolu_01', output: '12 passed', isError: false },
    ])
    const blocks = [
      { type: 'text', text: 'Line one.' },
      { type: 'image', source: {} },
      { type: 'text', text: 'Line two.' },
    ]
    expect(parse(sdk.toolResult('toolu_02', blocks, true))).toEqual([
      { kind: AgentEventKind.ToolResult, toolUseId: 'toolu_02', output: 'Line one.\nLine two.', isError: true },
    ])
    const bare = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_03' }] } }
    expect(parse(bare)).toEqual([
      { kind: AgentEventKind.ToolResult, toolUseId: 'toolu_03', output: '', isError: false },
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
      }),
    ])
    expect(parse(sdk.result('', { api_error_status: 'n/a' }))).toEqual([
      expect.objectContaining({ apiErrorStatus: null }),
    ])
  })

  it('reads the notice of a retried API request', () => {
    expect(parse(sdk.apiRetry(2, 10))).toEqual([
      { kind: AgentEventKind.ApiRetry, attempt: 2, maxRetries: 10, delayMs: 1000, status: 529, code: 'overloaded' },
    ])
    const connection = { ...(sdk.apiRetry(1) as object), error_status: null, error: 'unknown', retry_delay_ms: 'x' }
    expect(parse(connection)).toEqual([expect.objectContaining({ status: null, code: 'unknown', delayMs: 0 })])
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
      },
    ])
  })

  it('drops the message types and system subtypes Glade does not use, without a word', () => {
    const { parse: parseQuietly, warn } = parser()
    for (const message of [
      ...sdk.turnStartNoise(),
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
