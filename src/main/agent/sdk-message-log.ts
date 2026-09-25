/**
 * What the log says about each message the SDK sends (`docs/logs.md`): its type and subtype, and what matters about
 * it, without its text. An assistant message lists its blocks (each tool call's name and id, and how long each text
 * is), a user message its tool results, a result its usage, cost and duration, and a system message the fields of its
 * subtype that say what happened (the session's id and model, a subagent's task, a retry, a compaction). The text itself
 * is logged by the chat and tool log (`../logging/event-log`).
 *
 * It reads the message as it comes, `unknown`, and never throws: a field that isn't there, or isn't what it should be,
 * is left out.
 */
import { LogLevel, type LogFields } from '../logging/logger'

/** A message's line in the log. */
export interface SdkMessageLog {
  readonly level: LogLevel
  readonly fields: LogFields
}

type Json = Readonly<Record<string, unknown>>

function record(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/** `from`'s fields named in `keys` that are set, as they are. */
function pick(from: Json, keys: readonly string[]): Json {
  const picked: Record<string, unknown> = {}
  for (const key of keys) if (from[key] !== undefined) picked[key] = from[key]
  return picked
}

/** How long a text is, in characters, or 0 for something that isn't text. */
function chars(value: unknown): number {
  if (typeof value === 'string') return value.length
  return list(value).reduce<number>((total, part) => total + chars(record(part)?.text), 0)
}

/** A content block, as its kind and what identifies it. */
function block(raw: unknown): Json {
  const part = record(raw) ?? {}
  switch (part.type) {
    case 'text':
      return { type: 'text', chars: chars(part.text) }
    case 'thinking':
      return { type: 'thinking', chars: chars(part.thinking) }
    case 'tool_use':
      return { type: 'tool_use', ...pick(part, ['name', 'id']) }
    case 'tool_result':
      return { type: 'tool_result', toolUseId: part.tool_use_id, isError: part.is_error === true, chars: chars(part.content) }
    default:
      return { type: part.type }
  }
}

/** The fields each system subtype has worth logging. */
const SYSTEM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  init: ['session_id', 'model', 'cwd', 'permissionMode', 'claude_code_version', 'apiKeySource'],
  api_retry: ['attempt', 'max_retries', 'retry_delay_ms', 'error_status', 'error'],
  task_started: ['task_id', 'tool_use_id', 'description', 'task_type'],
  task_progress: ['task_id', 'tool_use_id', 'last_tool_name', 'usage'],
  task_notification: ['task_id', 'tool_use_id', 'status', 'summary', 'usage'],
  compact_boundary: ['compact_metadata'],
  status: ['status', 'compact_result'],
}

function system(message: Json): Json {
  const subtype = typeof message.subtype === 'string' ? message.subtype : ''
  const fields = pick(message, SYSTEM_FIELDS[subtype] ?? [])
  if (subtype !== 'init') return fields
  return {
    ...fields,
    tools: list(message.tools).length,
    mcpServers: list(message.mcp_servers).map((server) => pick(record(server) ?? {}, ['name', 'status'])),
  }
}

function assistant(message: Json): Json {
  const body = record(message.message) ?? {}
  return {
    ...pick(body, ['id', 'model', 'stop_reason', 'usage']),
    ...pick(message, ['error']),
    blocks: list(body.content).map(block),
  }
}

function user(message: Json): Json {
  const content = record(message.message)?.content
  return {
    ...pick(message, ['isReplay', 'uuid']),
    blocks: typeof content === 'string' ? [{ type: 'text', chars: content.length }] : list(content).map(block),
  }
}

const RESULT_FIELDS = [
  'is_error',
  'num_turns',
  'duration_ms',
  'duration_api_ms',
  'total_cost_usd',
  'usage',
  'terminal_reason',
  'errors',
  'api_error_status',
  'user_message_uuids',
]

function rateLimit(message: Json): Json {
  return pick(record(message.rate_limit_info) ?? {}, ['status', 'resetsAt', 'rateLimitType'])
}

/** Whether a message says something failed: an API error in place of a reply, or a turn that ended on an error. */
function failed(message: Json): boolean {
  return (message.type === 'assistant' && message.error !== undefined) || (message.type === 'result' && message.is_error === true)
}

/** The log line for an SDK message, as it arrived. */
export function describeSdkMessage(raw: unknown): SdkMessageLog {
  const message = record(raw)
  if (message === undefined) return { level: LogLevel.Warn, fields: { type: null } }
  const { type, subtype } = message
  const head: Json = {
    type,
    ...(subtype === undefined ? {} : { subtype }),
    ...pick(message, ['parent_tool_use_id']),
  }
  const detail = ((): Json => {
    switch (type) {
      case 'system':
        return system(message)
      case 'assistant':
        return assistant(message)
      case 'user':
        return user(message)
      case 'result':
        return pick(message, RESULT_FIELDS)
      case 'rate_limit_event':
        return rateLimit(message)
      default:
        return {}
    }
  })()
  return { level: failed(message) ? LogLevel.Warn : LogLevel.Debug, fields: { ...head, ...detail } }
}
