// Test helper: SDK messages shaped like the real ones in `docs/sdk-notes.md` §2, with made-up ids and content. Each
// builder returns what the SDK would stream, including fields Glade ignores, so the parser is tested on the real shape.

export const SESSION_ID = '3f1c9a52-7d2e-4b8a-9c11-0e5f6a7b8c9d'
export const MODEL = 'claude-sample-1'
/** The context window results report for `MODEL`. */
export const CONTEXT_WINDOW = 200_000
/** The context each assistant message reports using: its input, cache read and cache creation tokens. */
export const CONTEXT_USED = 22_846

export function init(sessionId = SESSION_ID): unknown {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd: '/code/acme-api',
    model: MODEL,
    permissionMode: 'bypassPermissions',
    apiKeySource: 'none',
    tools: ['Agent', 'Bash', 'Edit', 'Read'],
    mcp_servers: [],
    uuid: 'b0a1c2d3-0000-4000-8000-000000000001',
  }
}

/** The other messages a turn starts with, which Glade ignores. */
export function turnStartNoise(): unknown[] {
  return [
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, session_id: SESSION_ID },
    { type: 'system', subtype: 'status', status: 'requesting', session_id: SESSION_ID },
    { type: 'system', subtype: 'thinking_tokens', session_id: SESSION_ID },
  ]
}

function assistant(content: unknown[], parent: string | null, messageId: string): unknown {
  return {
    type: 'assistant',
    parent_tool_use_id: parent,
    session_id: SESSION_ID,
    uuid: `${messageId}-uuid`,
    message: {
      id: messageId,
      model: MODEL,
      stop_reason: null,
      content,
      usage: { input_tokens: 10, cache_creation_input_tokens: 1272, cache_read_input_tokens: 21564, output_tokens: 1 },
    },
  }
}

/** `message`, an assistant message, with its usage replaced: its prompt used `tokens` of context. */
export function withContextUsed(message: unknown, tokens: number): unknown {
  const assistantMessage = message as { message: Record<string, unknown> }
  return {
    ...assistantMessage,
    message: {
      ...assistantMessage.message,
      usage: {
        input_tokens: 6,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: tokens - 1006,
        output_tokens: 1,
      },
    },
  }
}

export function thinking(messageId = 'msg_01'): unknown {
  return assistant([{ type: 'thinking', thinking: 'Let me look.', signature: 'sig' }], null, messageId)
}

export function text(body: string, parent: string | null = null, messageId = 'msg_01'): unknown {
  return assistant([{ type: 'text', text: body }], parent, messageId)
}

export function toolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
  parent: string | null = null,
  messageId = 'msg_01',
): unknown {
  return {
    ...(assistant([{ type: 'tool_use', id, name, input }], parent, messageId) as object),
    tool_use_meta: [{ id, display_name: name }],
  }
}

export function toolResult(
  toolUseId: string,
  content: string | unknown[],
  isError = false,
  parent: string | null = null,
): unknown {
  return {
    type: 'user',
    parent_tool_use_id: parent,
    session_id: SESSION_ID,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
    tool_use_result: { stdout: typeof content === 'string' ? content : '', stderr: '', interrupted: false },
  }
}

export function result(reply: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: reply,
    session_id: SESSION_ID,
    num_turns: 4,
    stop_reason: 'end_turn',
    terminal_reason: 'completed',
    duration_ms: 7620,
    duration_api_ms: 8073,
    total_cost_usd: 0.0285,
    usage: { input_tokens: 28, cache_creation_input_tokens: 9443, cache_read_input_tokens: 58094, output_tokens: 553 },
    modelUsage: {
      [MODEL]: {
        inputTokens: 953,
        outputTokens: 566,
        cacheReadInputTokens: 58094,
        cacheCreationInputTokens: 9443,
        webSearchRequests: 0,
        costUSD: 0.0285,
        contextWindow: CONTEXT_WINDOW,
        maxOutputTokens: 32000,
      },
    },
    permission_denials: [],
    ...overrides,
  }
}

/** What an overloaded API says, as the SDK words it. */
export const OVERLOADED_ERROR =
  'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011Sample"}'

/** A turn that failed on an API error: the SDK's "success" subtype, but flagged as an error, with the error as its text. */
export function apiErrorResult(text = OVERLOADED_ERROR, status: number | null = 529): unknown {
  return result(text, { is_error: true, terminal_reason: 'api_error', api_error_status: status, errors: [] })
}

/** The assistant message the SDK makes of an API request it gave up on: the error, in place of the model's reply. */
export function apiErrorMessage(code = 'overloaded', text = OVERLOADED_ERROR, parent: string | null = null): unknown {
  return {
    ...(assistant([{ type: 'text', text }], parent, 'msg_api_error') as object),
    error: code,
  }
}

/** What the API says when the account's usage limit has run out, as the SDK words it. */
export const USAGE_LIMIT_ERROR = "You've hit your session limit · resets 11:42am"

/** What the SDK says when it couldn't reach the API at all, once its retries are spent. */
export const CONNECTION_ERROR = 'API Error: Connection error.'

/**
 * Where the account's usage limit stands (`rate_limit_event`, subscription logins only), with its reset time in epoch
 * seconds, as the SDK gives it.
 */
export function rateLimit(status: 'allowed' | 'allowed_warning' | 'rejected', resetsAtSeconds?: number): unknown {
  return {
    type: 'rate_limit_event',
    rate_limit_info: {
      status,
      ...(resetsAtSeconds === undefined ? {} : { resetsAt: resetsAtSeconds }),
      rateLimitType: 'five_hour',
    },
    uuid: `rate-limit-${status}`,
    session_id: SESSION_ID,
  }
}

/** A turn that ran into the usage limit: the rejected limit, the API error the SDK makes of it, and the failed result. */
export function usageLimitTurnEnd(resetsAtSeconds?: number): unknown[] {
  return [
    rateLimit('rejected', resetsAtSeconds),
    apiErrorMessage('rate_limit', USAGE_LIMIT_ERROR),
    apiErrorResult(USAGE_LIMIT_ERROR, 429),
  ]
}

/** A turn that couldn't reach the API: the connection error the SDK gives up with, and the failed result. */
export function offlineTurnEnd(): unknown[] {
  return [apiErrorMessage('unknown', CONNECTION_ERROR), apiErrorResult(CONNECTION_ERROR, null)]
}

/** The notice the SDK sends before it retries a failed API request (`docs/sdk-notes.md`, "Errors and retries"). */
export function apiRetry(attempt: number, maxRetries = 10, status: number | null = 529, code = 'overloaded'): unknown {
  return {
    type: 'system',
    subtype: 'api_retry',
    attempt,
    max_retries: maxRetries,
    retry_delay_ms: 500 * 2 ** (attempt - 1),
    error_status: status,
    error: code,
    uuid: `retry-${String(attempt)}`,
    session_id: SESSION_ID,
  }
}

/** The partial text the SDK flushes when a turn is interrupted mid-text, flagged as aborted. */
export function abortedText(body: string, messageId = 'msg_01'): unknown {
  return { ...(text(body, null, messageId) as object), aborted: true }
}

/** The marker the SDK adds to the transcript when a turn is interrupted: a user message Glade ignores. */
export function interruptMarker(duringTool = false): unknown {
  const marker = duringTool ? '[Request interrupted by user for tool use]' : '[Request interrupted by user]'
  return {
    type: 'user',
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    message: { role: 'user', content: [{ type: 'text', text: marker }] },
  }
}

/** The result of an interrupted turn (`docs/sdk-notes.md`, Interrupt). */
/**
 * The zeroed result Claude Code writes before it exits on a start that failed for a known reason, with
 * `CLAUDE_CODE_STARTUP_FAILURE_RESULTS` set (from the SDK's types: `SDKResultError.startup_failure_reason`). Its
 * `errors` carry what it printed to stderr. No `system/init` comes before it.
 */
export function startupFailureResult(reason: string, error: string): unknown {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    session_id: SESSION_ID,
    num_turns: 0,
    duration_ms: 0,
    duration_api_ms: 0,
    total_cost_usd: 0,
    usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    errors: [error],
    startup_failure_reason: reason,
  }
}

export function abortedResult(terminalReason: 'aborted_streaming' | 'aborted_tools' = 'aborted_streaming'): unknown {
  return result('', { subtype: 'error_during_execution', is_error: true, terminal_reason: terminalReason })
}

/**
 * What a manual `/compact` streams before its result (`docs/sdk-notes.md`, Compaction): the compacting status, its
 * outcome, the boundary with the tokens before and after, and the summary the session continues from.
 */
export function compaction(preTokens: number, postTokens: number, trigger: 'manual' | 'auto' = 'manual'): unknown[] {
  return [
    { type: 'system', subtype: 'status', status: 'compacting', session_id: SESSION_ID },
    { type: 'system', subtype: 'status', status: null, compact_result: 'success', session_id: SESSION_ID },
    compactBoundary({ trigger, pre_tokens: preTokens, post_tokens: postTokens, duration_ms: 21483 }),
    {
      type: 'user',
      session_id: SESSION_ID,
      message: {
        role: 'user',
        content: 'This session is being continued from a previous conversation that ran out of context. Summary: …',
      },
    },
  ]
}

/** A `compact_boundary` with the given metadata. */
export function compactBoundary(metadata: Record<string, unknown>): unknown {
  return { type: 'system', subtype: 'compact_boundary', session_id: SESSION_ID, compact_metadata: metadata }
}

/** The result a `/compact` ends with: no model turns and no reply. */
export function compactResult(): unknown {
  return result('', { num_turns: 0, duration_ms: 21483 })
}

/**
 * What the SDK streams when a background task (a command or a subagent) finishes between turns, before the turn it
 * starts: the task's status patch, then its notification (`docs/sdk-notes.md`, "Turns the agent starts itself").
 */
export function taskFinished(toolUseId: string, summary = 'Background command "Build the docs" completed'): unknown[] {
  return [
    {
      type: 'system',
      subtype: 'task_updated',
      task_id: 'b88t',
      patch: { status: 'completed' },
      session_id: SESSION_ID,
    },
    {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'b88t',
      tool_use_id: toolUseId,
      status: 'completed',
      output_file: 'tasks/b88t.output',
      summary,
      session_id: SESSION_ID,
    },
  ]
}

/** The `result` of a turn the agent started on its own: it says why, and names no message of yours. */
export function selfStartedResult(reply: string): unknown {
  return result(reply, { origin: { kind: 'task-notification' }, num_turns: 1 })
}

/**
 * What the SDK streams when the agent starts a subagent in the background (`docs/sdk-notes.md`, "Background
 * subagents"): the `Agent` call, its `task_started` (`is_backgrounded`), and at once its "launched" result.
 */
export function backgroundLaunch(toolUseId: string, sdkTaskId: string, description: string): unknown[] {
  return [
    toolUse(toolUseId, 'Agent', { description, prompt: `${description}.`, run_in_background: true }),
    {
      type: 'system',
      subtype: 'task_started',
      task_id: sdkTaskId,
      tool_use_id: toolUseId,
      description,
      subagent_type: 'general-purpose',
      is_backgrounded: true,
      spawn_depth: 1,
      task_type: 'local_agent',
      session_id: SESSION_ID,
    },
    launchedResult(toolUseId, sdkTaskId),
  ]
}

/** The result of an `Agent` call whose subagent runs in the background: it only says the subagent was launched. */
export function launchedResult(toolUseId: string, sdkTaskId: string): unknown {
  return {
    type: 'user',
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: 'Async agent launched.' }] },
      ],
    },
    tool_use_result: { isAsync: true, status: 'async_launched', agentId: sdkTaskId },
  }
}

/** What the SDK streams when a background subagent ends: its status patch, then its notification. */
export function subagentEnded(
  toolUseId: string,
  sdkTaskId: string,
  status: 'completed' | 'failed' | 'stopped',
  summary: string,
): unknown[] {
  return [
    {
      type: 'system',
      subtype: 'task_updated',
      task_id: sdkTaskId,
      patch: { status: status === 'stopped' ? 'killed' : status, end_time: 1_790_000_000_000 },
      session_id: SESSION_ID,
    },
    {
      type: 'system',
      subtype: 'task_notification',
      task_id: sdkTaskId,
      tool_use_id: toolUseId,
      status,
      output_file: `tasks/${sdkTaskId}.output`,
      summary,
      usage: { total_tokens: 12_688, tool_uses: 1, duration_ms: 17_116 },
      session_id: SESSION_ID,
    },
  ]
}

/**
 * What the SDK streams when the agent arms a `Monitor` (`docs/sdk-notes.md` §11): the call, the watch starting as a
 * background task (`local_bash`), and at once the call's "started" result.
 */
export function monitorStarted(toolUseId: string, sdkTaskId: string, description: string): unknown[] {
  return [
    toolUse(toolUseId, 'Monitor', { description, timeout_ms: 60_000, command: 'npm run ci:status -- --watch' }),
    {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: sdkTaskId, task_type: 'local_bash', description }],
      session_id: SESSION_ID,
    },
    {
      type: 'system',
      subtype: 'task_started',
      task_id: sdkTaskId,
      tool_use_id: toolUseId,
      description,
      is_backgrounded: true,
      task_type: 'local_bash',
      session_id: SESSION_ID,
    },
    {
      ...(toolResult(toolUseId, `Monitor started (task ${sdkTaskId}). You will be notified on each event.`) as object),
      tool_use_result: { taskId: sdkTaskId, timeoutMs: 60_000, persistent: false },
    },
  ]
}

/** What the SDK streams when a `Monitor`'s watch ends (its command exits), before the turn it starts. */
export function monitorEnded(toolUseId: string, sdkTaskId: string, description: string): unknown[] {
  return [
    { type: 'system', subtype: 'background_tasks_changed', tasks: [], session_id: SESSION_ID },
    {
      type: 'system',
      subtype: 'task_updated',
      task_id: sdkTaskId,
      patch: { status: 'completed', end_time: 1_790_000_000_000 },
      session_id: SESSION_ID,
    },
    {
      type: 'system',
      subtype: 'task_notification',
      task_id: sdkTaskId,
      tool_use_id: toolUseId,
      status: 'completed',
      output_file: `tasks/${sdkTaskId}.output`,
      summary: `Monitor "${description}" stream ended`,
      session_id: SESSION_ID,
    },
  ]
}

/**
 * What the SDK streams when the agent runs a command in the background (`Bash` with `run_in_background`,
 * `docs/sdk-notes.md` §13): the call, its task starting (`local_bash`), and at once the call's result naming the task.
 */
export function backgroundCommandStarted(
  toolUseId: string,
  sdkTaskId: string,
  description: string,
  command: string,
): unknown[] {
  return [
    toolUse(toolUseId, 'Bash', { command, description, run_in_background: true }),
    {
      type: 'system',
      subtype: 'task_started',
      task_id: sdkTaskId,
      tool_use_id: toolUseId,
      description,
      is_backgrounded: true,
      task_type: 'local_bash',
      session_id: SESSION_ID,
    },
    {
      ...(toolResult(toolUseId, `Command running in background with ID: ${sdkTaskId}.`) as object),
      tool_use_result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: sdkTaskId },
    },
  ]
}

/** What the SDK streams when a background task ends, as the probe saw (`docs/sdk-notes.md` §13). */
export function backgroundEnded(
  toolUseId: string,
  sdkTaskId: string,
  status: 'completed' | 'failed' | 'stopped',
  summary: string,
): unknown[] {
  return [
    {
      type: 'system',
      subtype: 'task_updated',
      task_id: sdkTaskId,
      patch: { status: status === 'stopped' ? 'killed' : status, end_time: 1_790_000_000_000 },
      session_id: SESSION_ID,
    },
    {
      type: 'system',
      subtype: 'task_notification',
      task_id: sdkTaskId,
      tool_use_id: toolUseId,
      status,
      output_file: `tasks/${sdkTaskId}.output`,
      summary,
      session_id: SESSION_ID,
    },
  ]
}

/** A `ScheduleWakeup` call and its result, as the probe saw (`docs/sdk-notes.md` §11). */
export function wakeupScheduled(toolUseId: string, input: Record<string, unknown>, scheduledFor: number): unknown[] {
  return [
    toolUse(toolUseId, 'ScheduleWakeup', input),
    {
      ...(toolResult(toolUseId, 'Next wakeup scheduled (in 300s).') as object),
      tool_use_result: { scheduledFor, clampedDelaySeconds: 300, wasClamped: false },
    },
  ]
}

/** A `CronCreate` call and its result, as the probe saw. */
export function cronCreated(
  toolUseId: string,
  input: Record<string, unknown>,
  id: string,
  humanSchedule: string,
): unknown[] {
  return [
    toolUse(toolUseId, 'CronCreate', input),
    {
      ...(toolResult(toolUseId, `Scheduled job ${id} (${humanSchedule}).`) as object),
      tool_use_result: { id, humanSchedule, recurring: input.recurring !== false, durable: false },
    },
  ]
}

/** A `CronDelete` call and its result. */
export function cronDeleted(toolUseId: string, id: string): unknown[] {
  return [
    toolUse(toolUseId, 'CronDelete', { id }),
    { ...(toolResult(toolUseId, `Cancelled job ${id}.`) as object), tool_use_result: { id } },
  ]
}

/**
 * What the SDK streams when a `ScheduleWakeup` or `CronCreate` job fires, before the turn it starts: the job's prompt
 * starting as a command of the SDK's own (`docs/sdk-notes.md` §11). The prompt itself never shows.
 */
export function scheduledFire(commandUuid = 'c7d1e2f3-0000-4000-8000-000000000001'): unknown {
  return { type: 'command_lifecycle', command_uuid: commandUuid, state: 'started', session_id: SESSION_ID }
}

/** The `result` of a turn a scheduled job started: no `origin`, and no message of yours. */
export function scheduledResult(reply: string): unknown {
  return result(reply, { num_turns: 1 })
}
