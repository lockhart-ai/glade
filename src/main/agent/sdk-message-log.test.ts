import { describe, expect, it } from 'vitest'
import { LogLevel } from '../logging/logger'
import { describeSdkMessage } from './sdk-message-log'
import * as sdk from './test-sdk-messages'

describe('describeSdkMessage', () => {
  it("logs a session's init: its id, model, folder, tools and MCP servers", () => {
    const init = { ...(sdk.init() as object), mcp_servers: [{ name: 'glade', status: 'connected', tools: [] }] }

    expect(describeSdkMessage(init)).toEqual({
      level: LogLevel.Debug,
      fields: {
        type: 'system',
        subtype: 'init',
        session_id: sdk.SESSION_ID,
        model: sdk.MODEL,
        cwd: '/code/acme-api',
        permissionMode: 'bypassPermissions',
        apiKeySource: 'none',
        tools: 4,
        mcpServers: [{ name: 'glade', status: 'connected' }],
      },
    })
  })

  it("logs an assistant message's blocks without their text: each tool call's name and id, and each text's length", () => {
    const message = sdk.toolUse('toolu_01', 'Bash', { command: 'npm test' }, 'toolu_00')
    const withText = sdk.text('Found two flaky tests.')

    expect(describeSdkMessage(message)).toEqual({
      level: LogLevel.Debug,
      fields: {
        type: 'assistant',
        parent_tool_use_id: 'toolu_00',
        id: 'msg_01',
        model: sdk.MODEL,
        stop_reason: null,
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 1272,
          cache_read_input_tokens: 21564,
          output_tokens: 1,
        },
        blocks: [{ type: 'tool_use', name: 'Bash', id: 'toolu_01' }],
      },
    })
    expect(describeSdkMessage(withText).fields.blocks).toEqual([{ type: 'text', chars: 22 }])
    expect(describeSdkMessage(sdk.thinking()).fields.blocks).toEqual([{ type: 'thinking', chars: 12 }])
    expect(JSON.stringify(describeSdkMessage(withText))).not.toContain('flaky')
  })

  it('logs an API error in place of a reply as a warning', () => {
    expect(describeSdkMessage(sdk.apiErrorMessage())).toMatchObject({
      level: LogLevel.Warn,
      fields: { type: 'assistant', error: 'overloaded' },
    })
  })

  it("logs a user message's tool results: which call, whether it failed, and how long", () => {
    expect(describeSdkMessage(sdk.toolResult('toolu_01', 'README.md', true))).toEqual({
      level: LogLevel.Debug,
      fields: {
        type: 'user',
        parent_tool_use_id: null,
        blocks: [{ type: 'tool_result', toolUseId: 'toolu_01', isError: true, chars: 9 }],
      },
    })
    const blocks = sdk.toolResult('toolu_02', [
      { type: 'text', text: 'one' },
      { type: 'image' },
      { type: 'text', text: 'two' },
    ])
    expect(describeSdkMessage(blocks).fields.blocks).toEqual([
      { type: 'tool_result', toolUseId: 'toolu_02', isError: false, chars: 6 },
    ])
    const typed = { type: 'user', isReplay: true, uuid: 'u-1', message: { role: 'user', content: 'Hi there' } }
    expect(describeSdkMessage(typed).fields).toEqual({
      type: 'user',
      isReplay: true,
      uuid: 'u-1',
      blocks: [{ type: 'text', chars: 8 }],
    })
  })

  it("logs a turn's result: how it ended, its usage, cost and duration", () => {
    expect(describeSdkMessage(sdk.result('Done.', { user_message_uuids: ['u-1'] }))).toEqual({
      level: LogLevel.Debug,
      fields: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 4,
        duration_ms: 7620,
        duration_api_ms: 8073,
        total_cost_usd: 0.0285,
        usage: {
          input_tokens: 28,
          cache_creation_input_tokens: 9443,
          cache_read_input_tokens: 58094,
          output_tokens: 553,
        },
        terminal_reason: 'completed',
        user_message_uuids: ['u-1'],
      },
    })
    expect(describeSdkMessage(sdk.apiErrorResult())).toMatchObject({
      level: LogLevel.Warn,
      fields: { type: 'result', is_error: true, api_error_status: 529 },
    })
  })

  it('logs what each system message says: retries, subagents, compaction and status', () => {
    const subagent = {
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-a',
      tool_use_id: 'toolu_09',
      description: 'Explore the tests',
      task_type: 'local_agent',
      is_backgrounded: true,
      prompt: 'Look through the tests.',
      session_id: sdk.SESSION_ID,
    }
    // Whether a command's task is in the background, and a subagent's, says whether it's a watcher, and whose.
    const command = {
      type: 'system',
      subtype: 'task_started',
      task_id: 'b-cmd',
      tool_use_id: 'toolu_10',
      description: 'Run the suite',
      task_type: 'local_bash',
      is_backgrounded: false,
      owned_by_subagent: true,
    }
    const moved = { type: 'system', subtype: 'task_updated', task_id: 'b-cmd', patch: { is_backgrounded: true } }
    const notification = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-a',
      tool_use_id: 'toolu_09',
      status: 'completed',
      summary: 'Found it',
    }

    expect(describeSdkMessage(sdk.apiRetry(2)).fields).toEqual({
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 10,
      retry_delay_ms: expect.any(Number) as unknown,
      error_status: 529,
      error: 'overloaded',
    })
    expect(describeSdkMessage(subagent).fields).toEqual({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-a',
      tool_use_id: 'toolu_09',
      description: 'Explore the tests',
      task_type: 'local_agent',
      is_backgrounded: true,
    })
    expect(describeSdkMessage(command).fields).toMatchObject({ is_backgrounded: false, owned_by_subagent: true })
    expect(describeSdkMessage(moved).fields).toEqual({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'b-cmd',
      patch: { is_backgrounded: true },
    })
    expect(describeSdkMessage(notification).fields).toMatchObject({ status: 'completed', summary: 'Found it' })
    expect(
      describeSdkMessage(
        sdk.compaction(180_000, 40_000).find((message) => JSON.stringify(message).includes('compact_boundary')),
      ).fields,
    ).toMatchObject({
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 180_000, post_tokens: 40_000 },
    })
    expect(describeSdkMessage({ type: 'system', subtype: 'status', status: 'compacting' }).fields).toEqual({
      type: 'system',
      subtype: 'status',
      status: 'compacting',
    })
    expect(describeSdkMessage({ type: 'system', subtype: 'hook_started', hook: 'x' }).fields).toEqual({
      type: 'system',
      subtype: 'hook_started',
    })
    expect(describeSdkMessage({ type: 'system' }).fields).toEqual({ type: 'system' })
  })

  it('logs the usage limit, and just the type of anything else', () => {
    expect(describeSdkMessage(sdk.rateLimit('rejected', 1_790_000_000)).fields).toEqual({
      type: 'rate_limit_event',
      status: 'rejected',
      resetsAt: 1_790_000_000,
      rateLimitType: 'five_hour',
    })
    expect(describeSdkMessage({ type: 'rate_limit_event' }).fields).toEqual({ type: 'rate_limit_event' })
    expect(describeSdkMessage({ type: 'stream_event', event: { delta: 'secret' } }).fields).toEqual({
      type: 'stream_event',
    })
  })

  it("logs a message that isn't one, or has odd blocks, without throwing", () => {
    expect(describeSdkMessage(null)).toEqual({ level: LogLevel.Warn, fields: { type: null } })
    expect(describeSdkMessage(['not', 'a', 'message'])).toEqual({ level: LogLevel.Warn, fields: { type: null } })
    const odd = { type: 'assistant', message: { content: [null, { type: 'redacted_thinking' }, { type: 'text' }] } }
    expect(describeSdkMessage(odd).fields).toEqual({
      type: 'assistant',
      blocks: [{ type: undefined }, { type: 'redacted_thinking' }, { type: 'text', chars: 0 }],
    })
    expect(describeSdkMessage({ type: 'assistant' }).fields).toEqual({ type: 'assistant', blocks: [] })
    expect(describeSdkMessage({ type: 'user', message: { content: 7 } }).fields).toEqual({ type: 'user', blocks: [] })
  })
})
