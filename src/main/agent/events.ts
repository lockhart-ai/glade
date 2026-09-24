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
import { CompactionTrigger, type ToolInput } from '../../shared/domain'

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
}

export interface SessionFailedEvent {
  readonly kind: AgentEventKind.SessionFailed
  readonly message: string
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

/** Where parsing reports what it drops. */
export interface AgentLog {
  warn(message: string, ...details: unknown[]): void
}

// SDK message types Glade knowingly doesn't use (yet). Dropped without a word; any other unknown type is logged.
const IGNORED_TYPES: ReadonlySet<string> = new Set([
  'auth_status',
  'command_lifecycle',
  'prompt_suggestion',
  'rate_limit_event',
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

const tokenCount = z.number().int().nonnegative()

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
  // A message without usage (or with a malformed one) still has content worth showing.
  message: z.looseObject({ content: z.array(block), usage: usage.optional().catch(undefined) }),
})

const userMessage = z.looseObject({
  type: z.literal('user'),
  parent_tool_use_id: parentToolUseId,
  // Replays of earlier messages, when a session asks for them, aren't news.
  isReplay: z.boolean().optional(),
  message: z.looseObject({ content: z.union([z.string(), z.array(block)]) }),
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

function fromAssistant(message: z.infer<typeof assistantMessage>, log: AgentLog): AgentEvent[] {
  const parent = message.parent_tool_use_id ?? null
  const blocks = message.message.content.flatMap((raw): AgentEvent[] => {
    switch (raw.type) {
      case 'text': {
        const text = textBlock.safeParse(raw)
        if (text.success) return [{ kind: AgentEventKind.Text, text: text.data.text, parentToolUseId: parent }]
        log.warn('Dropped a malformed text block from the agent', text.error.message)
        return []
      }
      case 'tool_use': {
        const call = toolUseBlock.safeParse(raw)
        if (call.success) {
          const { id, name, input } = call.data
          return [{ kind: AgentEventKind.ToolCallStarted, toolUseId: id, name, input, parentToolUseId: parent }]
        }
        log.warn('Dropped a malformed tool call from the agent', call.error.message)
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
  return content.flatMap((raw): AgentEvent[] => {
    if (raw.type !== 'tool_result') return []
    const result = toolResultBlock.safeParse(raw)
    if (!result.success) {
      log.warn('Dropped a malformed tool result', result.error.message)
      return []
    }
    const { tool_use_id, content: output, is_error } = result.data
    return [
      {
        kind: AgentEventKind.ToolResult,
        toolUseId: tool_use_id,
        output: resultText(output),
        isError: is_error ?? false,
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
  log.warn(`Dropped a malformed ${what} message from the agent`, result.error.message)
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
      log.warn('Dropped an SDK message with no type', head.error.message)
      return []
    }
    const { type, subtype } = head.data
    switch (type) {
      case 'system':
        if (subtype === 'init') return parsed(initMessage, raw, log, 'system/init', fromInit)
        if (subtype === 'status') return parsed(statusMessage, raw, log, 'system/status', fromStatus)
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
      default:
        if (!IGNORED_TYPES.has(type) && !reported.has(type)) {
          reported.add(type)
          log.warn(`Ignored SDK messages of the unknown type ${type}`)
        }
        return []
    }
  }
}
