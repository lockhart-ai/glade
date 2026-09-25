/**
 * The agent's events, as the runner sees them, and how SDK messages become them. Each SDK message arrives as `unknown`
 * and is parsed here with zod, at the boundary; the rest of the app never sees an SDK message. The shapes follow
 * `docs/sdk-notes.md` §2.
 *
 * Parsing never throws. A message of a type Glade doesn't use, or a content block it doesn't use (such as thinking), is
 * dropped; a message of an unknown type, or one that doesn't have the shape its type promises, is logged and dropped.
 * The one exception is a turn's `result`: a malformed one still ends the turn, as an error, so the task never waits on
 * a turn that has already finished.
 */
import { z } from 'zod'
import { CompactionTrigger, type EpochMs, type ToolInput } from '../../shared/domain'
import type { Logger } from '../logging/logger'

export enum AgentEventKind {
  /** The session is running: it names its SDK session id. Arrives at the start of every turn. */
  SessionStarted = 'session_started',
  /** A block of the agent's text: preamble before a tool call, or its final reply. */
  Text = 'text',
  ToolCallStarted = 'tool_call_started',
  ToolResult = 'tool_result',
  /** How full the context is: what the agent's latest top-level message used. */
  ContextUsed = 'context_used',
  /**
   * The session started compacting its context (`status: compacting`): the SDK doing it on its own at its threshold,
   * or a `/compact` Glade sent.
   */
  Compacting = 'compacting',
  /** The session's context was compacted (`compact_boundary`), manually or automatically. */
  Compacted = 'compacted',
  /** The session's compaction failed (`compact_result: failed`). */
  CompactionFailed = 'compaction_failed',
  /** The turn ended, successfully or not. Exactly one per turn. */
  TurnFinished = 'turn_finished',
  /** The agent process failed, or its session ended while a turn was running. No `TurnFinished` follows. */
  SessionFailed = 'session_failed',
  /** An API request failed, and Claude Code will retry it after a delay (`system/api_retry`). */
  ApiRetry = 'api_retry',
  /**
   * An API request failed for good: the SDK's assistant message that carries the error, in place of the model's reply.
   * The turn's error `result` follows.
   */
  ApiError = 'api_error',
  /**
   * The account's usage limit, as the API's rate limit headers report it (`rate_limit_event`, subscription logins
   * only): whether it's rejecting requests, and when it resets.
   */
  RateLimit = 'rate_limit',
  /**
   * A subagent started, as a task the session can stop on its own (`system/task_started`): the SDK's id for the task,
   * and the `Agent` tool call that started it.
   */
  SubagentStarted = 'subagent_started',
  /**
   * A subagent was moved to the background after it started in the foreground (`system/task_updated` with
   * `patch.is_backgrounded`): its `Agent` call returns at once, and the subagent carries on.
   */
  SubagentBackgrounded = 'subagent_backgrounded',
  /**
   * A task started by a tool call ended (`system/task_notification`): for a background subagent, this, not its `Agent`
   * call's result, is when it finished (`docs/sdk-notes.md`, "Background subagents").
   */
  TaskFinished = 'task_finished',
}

export interface SessionStartedEvent {
  readonly kind: AgentEventKind.SessionStarted
  readonly sessionId: string
  /** The model the turn runs on, as the SDK names it. */
  readonly model: string
}

export interface TextEvent {
  readonly kind: AgentEventKind.Text
  readonly text: string
  /** The `Agent` tool call's id when a subagent wrote it; null at the top level. */
  readonly parentToolUseId: string | null
}

export interface ToolCallStartedEvent {
  readonly kind: AgentEventKind.ToolCallStarted
  readonly toolUseId: string
  readonly name: string
  readonly input: ToolInput
  /** The `Agent` tool call's id when a subagent made the call; null at the top level. */
  readonly parentToolUseId: string | null
}

export interface ToolResultEvent {
  readonly kind: AgentEventKind.ToolResult
  readonly toolUseId: string
  /** The result's text. */
  readonly output: string
  readonly isError: boolean
  /**
   * Whether the result only says a background subagent was launched (`tool_use_result.status: async_launched`): the
   * call returned, but the subagent carries on until its `TaskFinished`.
   */
  readonly launched: boolean
}

export interface ContextUsedEvent {
  readonly kind: AgentEventKind.ContextUsed
  /** The prompt the model just saw, in tokens: the message's input, cache read and cache creation tokens. */
  readonly tokens: number
}

export interface CompactingEvent {
  readonly kind: AgentEventKind.Compacting
}

export interface CompactionFailedEvent {
  readonly kind: AgentEventKind.CompactionFailed
}

export interface CompactedEvent {
  readonly kind: AgentEventKind.Compacted
  readonly trigger: CompactionTrigger
  /** The context before, in tokens. */
  readonly preTokens: number
  /**
   * The context after, in tokens: the new baseline until the next assistant message (`docs/sdk-notes.md`, "Usage and
   * context size"). Null when the SDK doesn't say.
   */
  readonly postTokens: number | null
}

/** A turn's token usage, for its main loop only. */
export interface TurnUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadInputTokens: number
  readonly cacheCreationInputTokens: number
}

export interface TurnFinishedEvent {
  readonly kind: AgentEventKind.TurnFinished
  /** Whether the turn failed. The SDK's own error flag, not its subtype (an API error comes as a "success"). */
  readonly isError: boolean
  /** The final reply's text on success; usually empty on failure. */
  readonly result: string
  /** Why the turn failed, when the SDK says. */
  readonly errors: readonly string[]
  /** How the turn ended, e.g. `completed`, `api_error` or `aborted_streaming`; null when the SDK doesn't say. */
  readonly terminalReason: string | null
  readonly durationMs: number | null
  readonly usage: TurnUsage | null
  /** The estimated cost of the whole session so far, in US dollars. */
  readonly totalCostUsd: number | null
  /** The context window of each model the session has used, in tokens, by the model id the SDK reports. */
  readonly contextWindows: Readonly<Record<string, number>>
  /**
   * The uuids of the user messages the turn answered: the one that started it and any folded into it. Null when the
   * SDK doesn't say.
   */
  readonly userMessageUuids: readonly string[] | null
  /** The HTTP status of the API error the turn ended on; null when it didn't end on one. */
  readonly apiErrorStatus: number | null
}

export interface SessionFailedEvent {
  readonly kind: AgentEventKind.SessionFailed
  readonly message: string
}

export interface ApiRetryEvent {
  readonly kind: AgentEventKind.ApiRetry
  /** Which retry this is, from 1. */
  readonly attempt: number
  readonly maxRetries: number
  readonly delayMs: number
  /** The failed request's HTTP status; null for a connection error. */
  readonly status: number | null
  /** The SDK's name for the error, e.g. `overloaded`. */
  readonly code: string
}

export interface ApiErrorEvent {
  readonly kind: AgentEventKind.ApiError
  /** The SDK's name for the error, e.g. `overloaded`. */
  readonly code: string
  /** The error's text, e.g. `API Error: 529 {"type":"error",…}`. */
  readonly message: string
}

/** Where the account's usage limit stands (the SDK's `SDKRateLimitInfo.status`). */
export enum RateLimitStatus {
  Allowed = 'allowed',
  /** Allowed, but close to the limit. */
  AllowedWarning = 'allowed_warning',
  /** The limit ran out: requests are rejected until it resets. */
  Rejected = 'rejected',
}

export interface RateLimitEvent {
  readonly kind: AgentEventKind.RateLimit
  readonly status: RateLimitStatus
  /** When the limit resets; null when the SDK doesn't say. The SDK gives epoch seconds; this is milliseconds. */
  readonly resetsAt: EpochMs | null
}

export interface SubagentStartedEvent {
  readonly kind: AgentEventKind.SubagentStarted
  /** The SDK's id for the subagent's task, which stops it (`stopTask`). */
  readonly sdkTaskId: string
  /** The `Agent` tool call that started it. */
  readonly toolUseId: string
  /**
   * Whether it's a subagent running in the background (`is_backgrounded`, `task_type: local_agent`): its `Agent` call
   * returns at once, and it runs until its `TaskFinished`.
   */
  readonly background: boolean
}

export interface SubagentBackgroundedEvent {
  readonly kind: AgentEventKind.SubagentBackgrounded
  /** The SDK's id for the subagent's task. */
  readonly sdkTaskId: string
}

/** How a task started by a tool call ended (the SDK's `task_notification.status`). */
export enum TaskOutcome {
  Completed = 'completed',
  Failed = 'failed',
  /** Stopped with `stopTask` (Stop subagent). */
  Stopped = 'stopped',
}

export interface TaskFinishedEvent {
  readonly kind: AgentEventKind.TaskFinished
  /** The SDK's id for the task. */
  readonly sdkTaskId: string
  /** The tool call that started it. */
  readonly toolUseId: string
  readonly outcome: TaskOutcome
  /** What it came to: a subagent's final reply, or what failed. */
  readonly summary: string
}

/** Everything the runner reacts to. */
export type AgentEvent =
  | SessionStartedEvent
  | TextEvent
  | ToolCallStartedEvent
  | ToolResultEvent
  | ContextUsedEvent
  | CompactingEvent
  | CompactedEvent
  | CompactionFailedEvent
  | TurnFinishedEvent
  | SessionFailedEvent
  | ApiRetryEvent
  | ApiErrorEvent
  | RateLimitEvent
  | SubagentStartedEvent
  | SubagentBackgroundedEvent
  | TaskFinishedEvent

/** Where parsing reports what it drops: the task's agent log (`../logging/logger`). */
export type AgentLog = Pick<Logger, 'warn'>

// SDK message types Glade knowingly doesn't use (yet). Dropped without a word; any other unknown type is logged.
const IGNORED_TYPES: ReadonlySet<string> = new Set([
  'auth_status',
  'command_lifecycle',
  'prompt_suggestion',
  'stream_event',
  'tool_progress',
  'tool_use_summary',
])

const messageHead = z.looseObject({ type: z.string(), subtype: z.string().optional() })

const initMessage = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: z.string().min(1),
  model: z.string(),
})

const apiRetryMessage = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('api_retry'),
  attempt: z.int().positive(),
  max_retries: z.int().nonnegative(),
  retry_delay_ms: z.number().nonnegative().catch(0),
  error_status: z.int().nullable().catch(null),
  error: z.string().catch('unknown'),
})

// Only a task started by a tool call (a subagent, or a background command) can be matched to its row in the tool log.
const taskStartedMessage = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('task_started'),
  task_id: z.string().min(1),
  tool_use_id: z.string().min(1).optional(),
  // Anything but a clear "a subagent, in the background" is taken as a task its call waits on, as before.
  task_type: z.string().optional().catch(undefined),
  is_backgrounded: z.boolean().optional().catch(undefined),
})

const taskUpdatedMessage = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('task_updated'),
  task_id: z.string().min(1),
  patch: z.looseObject({ is_backgrounded: z.boolean().optional().catch(undefined) }),
})

// Only a task started by a tool call can be matched to its row; a status Glade doesn't know drops the message.
const taskNotificationMessage = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('task_notification'),
  task_id: z.string().min(1),
  tool_use_id: z.string().min(1).optional(),
  status: z.enum(TaskOutcome),
  summary: z.string().catch(''),
})

/** The SDK's own account of a tool call's result, beside its content: only whether it launched a subagent matters. */
const toolUseResult = z.looseObject({ status: z.unknown().optional() })

const tokenCount = z.number().int().nonnegative()

const rateLimitMessage = z.looseObject({
  type: z.literal('rate_limit_event'),
  rate_limit_info: z.looseObject({
    status: z.enum(RateLimitStatus),
    // Unix epoch seconds (the `anthropic-ratelimit-unified-reset` header). A malformed one is as good as missing.
    resetsAt: z.number().positive().optional().catch(undefined),
  }),
})

const compactBoundaryMessage = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('compact_boundary'),
  compact_metadata: z.looseObject({
    trigger: z.enum(CompactionTrigger),
    pre_tokens: tokenCount,
    // Optional in the SDK's types; a malformed one is as good as missing.
    post_tokens: tokenCount.optional().catch(undefined),
  }),
})

// `status` is null once a compaction ends, with `compact_result` saying how it went; `requesting` is ignored, as is
// anything else, so a status Glade doesn't know never logs.
const statusMessage = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('status'),
  status: z.unknown().optional(),
  compact_result: z.unknown().optional(),
})

const parentToolUseId = z.string().nullable().optional()

// Content blocks are checked one at a time, so a block of a kind Glade doesn't use never spoils its neighbours.
const block = z.looseObject({ type: z.string() })
const textBlock = z.looseObject({ type: z.literal('text'), text: z.string() })
const toolUseBlock = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
})
const toolResultBlock = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(block)]).optional(),
  is_error: z.boolean().optional(),
})

const count = z.number().catch(0)
const usage = z.looseObject({
  input_tokens: count,
  output_tokens: count,
  cache_read_input_tokens: count,
  cache_creation_input_tokens: count,
})

const assistantMessage = z.looseObject({
  type: z.literal('assistant'),
  parent_tool_use_id: parentToolUseId,
  // Set on the message the SDK makes of an API error that ended the turn: its text is the error, not the model's.
  error: z.string().optional(),
  // A message without usage (or with a malformed one) still has content worth showing.
  message: z.looseObject({ content: z.array(block), usage: usage.optional().catch(undefined) }),
})

const userMessage = z.looseObject({
  type: z.literal('user'),
  parent_tool_use_id: parentToolUseId,
  // Replays of earlier messages, when a session asks for them, aren't news.
  isReplay: z.boolean().optional(),
  message: z.looseObject({ content: z.union([z.string(), z.array(block)]) }),
  tool_use_result: toolUseResult.optional().catch(undefined),
})

// Every field is optional or falls back: see the module comment.
const resultMessage = z.looseObject({
  type: z.literal('result'),
  is_error: z.boolean().catch(true),
  result: z.string().catch(''),
  errors: z.array(z.string()).catch([]),
  terminal_reason: z.string().nullable().catch(null),
  duration_ms: z.number().nullable().catch(null),
  usage: usage.nullable().catch(null),
  total_cost_usd: z.number().nullable().catch(null),
  modelUsage: z.record(z.string(), z.unknown()).catch({}),
  user_message_uuids: z.array(z.string()).nullable().optional().catch(null),
  api_error_status: z.int().nullable().optional().catch(null),
})

function fromStatus(message: z.infer<typeof statusMessage>): AgentEvent[] {
  if (message.status === 'compacting') return [{ kind: AgentEventKind.Compacting }]
  if (message.compact_result === 'failed') return [{ kind: AgentEventKind.CompactionFailed }]
  return []
}

const modelUsage = z.looseObject({ contextWindow: z.number().int().positive() })

function fromInit(message: z.infer<typeof initMessage>): AgentEvent[] {
  return [{ kind: AgentEventKind.SessionStarted, sessionId: message.session_id, model: message.model }]
}

function fromCompactBoundary(message: z.infer<typeof compactBoundaryMessage>): AgentEvent[] {
  const { trigger, pre_tokens, post_tokens } = message.compact_metadata
  return [{ kind: AgentEventKind.Compacted, trigger, preTokens: pre_tokens, postTokens: post_tokens ?? null }]
}

/** A top-level message's usage says how full the context is (`docs/sdk-notes.md`, "Usage and context size"). */
function contextUsed(parent: string | null, messageUsage: z.infer<typeof usage> | undefined): AgentEvent[] {
  if (parent !== null || messageUsage === undefined) return []
  const tokens =
    messageUsage.input_tokens + messageUsage.cache_read_input_tokens + messageUsage.cache_creation_input_tokens
  return [{ kind: AgentEventKind.ContextUsed, tokens }]
}

function fromApiRetry(message: z.infer<typeof apiRetryMessage>): AgentEvent[] {
  return [
    {
      kind: AgentEventKind.ApiRetry,
      attempt: message.attempt,
      maxRetries: message.max_retries,
      delayMs: message.retry_delay_ms,
      status: message.error_status,
      code: message.error,
    },
  ]
}

function fromRateLimit(message: z.infer<typeof rateLimitMessage>): AgentEvent[] {
  const { status, resetsAt } = message.rate_limit_info
  return [{ kind: AgentEventKind.RateLimit, status, resetsAt: resetsAt === undefined ? null : resetsAt * 1000 }]
}

/** An API error's message: its text blocks, joined. */
function fromApiError(code: string, content: readonly z.infer<typeof block>[]): AgentEvent[] {
  return [{ kind: AgentEventKind.ApiError, code, message: resultText(content) }]
}

function fromAssistant(message: z.infer<typeof assistantMessage>, log: AgentLog): AgentEvent[] {
  const parent = message.parent_tool_use_id ?? null
  // A subagent's failed request is the subagent's business: its `Agent` call reports it.
  if (message.error !== undefined) return parent === null ? fromApiError(message.error, message.message.content) : []
  const blocks = message.message.content.flatMap((raw): AgentEvent[] => {
    switch (raw.type) {
      case 'text': {
        const text = textBlock.safeParse(raw)
        if (text.success) return [{ kind: AgentEventKind.Text, text: text.data.text, parentToolUseId: parent }]
        log.warn('Dropped a malformed text block from the agent', { problem: text.error.message })
        return []
      }
      case 'tool_use': {
        const call = toolUseBlock.safeParse(raw)
        if (call.success) {
          const { id, name, input } = call.data
          return [{ kind: AgentEventKind.ToolCallStarted, toolUseId: id, name, input, parentToolUseId: parent }]
        }
        log.warn('Dropped a malformed tool call from the agent', { problem: call.error.message })
        return []
      }
      default:
        return []
    }
  })
  return [...contextUsed(parent, message.message.usage), ...blocks]
}

/** A tool result's text: its string content, or its text blocks joined. */
function resultText(content: string | readonly z.infer<typeof block>[] | undefined): string {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  return content
    .map((part) => textBlock.safeParse(part))
    .flatMap((part) => (part.success ? [part.data.text] : []))
    .join('\n')
}

function fromUser(message: z.infer<typeof userMessage>, log: AgentLog): AgentEvent[] {
  const { content } = message.message
  if (message.isReplay === true || typeof content === 'string') return []
  // The SDK's account of the result belongs to the message's one tool result.
  const launched = message.tool_use_result?.status === 'async_launched'
  return content.flatMap((raw): AgentEvent[] => {
    if (raw.type !== 'tool_result') return []
    const result = toolResultBlock.safeParse(raw)
    if (!result.success) {
      log.warn('Dropped a malformed tool result', { problem: result.error.message })
      return []
    }
    const { tool_use_id, content: output, is_error } = result.data
    return [
      {
        kind: AgentEventKind.ToolResult,
        toolUseId: tool_use_id,
        output: resultText(output),
        isError: is_error ?? false,
        launched,
      },
    ]
  })
}

/** Each model's context window from a result's `modelUsage`, skipping any entry without one. */
function contextWindows(entries: Readonly<Record<string, unknown>>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(entries).flatMap(([model, raw]) => {
      const entry = modelUsage.safeParse(raw)
      return entry.success ? [[model, entry.data.contextWindow]] : []
    }),
  )
}

function fromResult(message: z.infer<typeof resultMessage>): AgentEvent[] {
  const { usage: turnUsage } = message
  return [
    {
      kind: AgentEventKind.TurnFinished,
      isError: message.is_error,
      result: message.result,
      errors: message.errors,
      terminalReason: message.terminal_reason,
      durationMs: message.duration_ms,
      totalCostUsd: message.total_cost_usd,
      contextWindows: contextWindows(message.modelUsage),
      userMessageUuids: message.user_message_uuids ?? null,
      apiErrorStatus: message.api_error_status ?? null,
      usage:
        turnUsage === null
          ? null
          : {
              inputTokens: turnUsage.input_tokens,
              outputTokens: turnUsage.output_tokens,
              cacheReadInputTokens: turnUsage.cache_read_input_tokens,
              cacheCreationInputTokens: turnUsage.cache_creation_input_tokens,
            },
    },
  ]
}

function fromTaskStarted(message: z.infer<typeof taskStartedMessage>): AgentEvent[] {
  const { task_id: sdkTaskId, tool_use_id: toolUseId } = message
  const background = message.task_type === 'local_agent' && message.is_backgrounded === true
  return toolUseId === undefined ? [] : [{ kind: AgentEventKind.SubagentStarted, sdkTaskId, toolUseId, background }]
}

function fromTaskUpdated(message: z.infer<typeof taskUpdatedMessage>): AgentEvent[] {
  if (message.patch.is_backgrounded !== true) return []
  return [{ kind: AgentEventKind.SubagentBackgrounded, sdkTaskId: message.task_id }]
}

function fromTaskNotification(message: z.infer<typeof taskNotificationMessage>): AgentEvent[] {
  const { task_id: sdkTaskId, tool_use_id: toolUseId, status: outcome, summary } = message
  return toolUseId === undefined ? [] : [{ kind: AgentEventKind.TaskFinished, sdkTaskId, toolUseId, outcome, summary }]
}

/** Parses `raw` with `schema`, or logs why it couldn't and gives nothing. */
function parsed<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  log: AgentLog,
  what: string,
  events: (value: T) => AgentEvent[],
) {
  const result = schema.safeParse(raw)
  if (result.success) return events(result.data)
  log.warn(`Dropped a malformed ${what} message from the agent`, { problem: result.error.message })
  return []
}

/**
 * Creates a parser from SDK messages to agent events. It logs each unknown message type once, so a new type the SDK
 * starts sending doesn't flood the log.
 */
export function createSdkMessageParser(log: AgentLog): (raw: unknown) => AgentEvent[] {
  const reported = new Set<string>()
  return (raw) => {
    const head = messageHead.safeParse(raw)
    if (!head.success) {
      log.warn('Dropped an SDK message with no type', { problem: head.error.message })
      return []
    }
    const { type, subtype } = head.data
    switch (type) {
      case 'system':
        if (subtype === 'init') return parsed(initMessage, raw, log, 'system/init', fromInit)
        if (subtype === 'status') return parsed(statusMessage, raw, log, 'system/status', fromStatus)
        if (subtype === 'api_retry') return parsed(apiRetryMessage, raw, log, 'system/api_retry', fromApiRetry)
        if (subtype === 'task_started') {
          return parsed(taskStartedMessage, raw, log, 'system/task_started', fromTaskStarted)
        }
        if (subtype === 'task_updated') {
          return parsed(taskUpdatedMessage, raw, log, 'system/task_updated', fromTaskUpdated)
        }
        if (subtype === 'task_notification') {
          return parsed(taskNotificationMessage, raw, log, 'system/task_notification', fromTaskNotification)
        }
        if (subtype === 'compact_boundary') {
          return parsed(compactBoundaryMessage, raw, log, 'system/compact_boundary', fromCompactBoundary)
        }
        return []
      case 'assistant':
        return parsed(assistantMessage, raw, log, 'assistant', (message) => fromAssistant(message, log))
      case 'user':
        return parsed(userMessage, raw, log, 'user', (message) => fromUser(message, log))
      case 'result':
        return fromResult(resultMessage.parse(raw))
      case 'rate_limit_event':
        return parsed(rateLimitMessage, raw, log, 'rate_limit_event', fromRateLimit)
      default:
        if (!IGNORED_TYPES.has(type) && !reported.has(type)) {
          reported.add(type)
          log.warn(`Ignored SDK messages of the unknown type ${type}`)
        }
        return []
    }
  }
}
