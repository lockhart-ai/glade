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
export function abortedResult(terminalReason: 'aborted_streaming' | 'aborted_tools' = 'aborted_streaming'): unknown {
  return result('', { subtype: 'error_during_execution', is_error: true, terminal_reason: terminalReason })
}
