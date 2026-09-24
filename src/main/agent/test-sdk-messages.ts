// Test helper: SDK messages shaped like the real ones in `docs/sdk-notes.md` §2, with made-up ids and content. Each
// builder returns what the SDK would stream, including fields Glade ignores, so the parser is tested on the real shape.

export const SESSION_ID = '3f1c9a52-7d2e-4b8a-9c11-0e5f6a7b8c9d'
export const MODEL = 'claude-sample-1'

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
    modelUsage: {},
    permission_denials: [],
    ...overrides,
  }
}

/** A turn that failed on an API error: the SDK's "success" subtype, but flagged as an error. */
export function apiErrorResult(): unknown {
  return result('', { is_error: true, terminal_reason: 'api_error', api_error_status: 529, errors: [] })
}
