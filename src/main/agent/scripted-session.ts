/**
 * Plays an agent script (see `./scripts`) as an `AgentSession`: each message sent runs the script's next turn, whose
 * steps become the SDK messages a real session would stream (shapes from `docs/sdk-notes.md` §2). Nothing runs a
 * model. The test modes' agent backend (`./test-mode-backend`) starts these.
 *
 * - Turns run one after another, in the order their messages were sent. The runner's `RESUME_PROMPT` runs the
 *   script's resume turn, if it has one. `/compact` runs its compact turn (by default `DEFAULT_COMPACT_TURN`), which
 *   isn't one of the script's turns: the message after it runs the next of those.
 * - Each assistant message reports the context the session has used: 22,846 tokens unless a step fills it, and what
 *   a compaction left after one.
 * - A message sent while a turn is playing is folded into it, as the SDK folds a message pushed mid-turn: before its
 *   next step, the turn drops the steps it has left and plays the script's next turn instead (without its init), and
 *   its `result` answers every message it took.
 * - An interrupt ends the running turn the way the SDK does: tool calls still running get a "rejected" result, then an
 *   interrupt marker and an `error_during_execution` result (`aborted_tools` if a call was running, else
 *   `aborted_streaming`).
 * - A `Fail` step kills the session: its message stream throws, and it plays nothing more.
 * - The script can be picked by the session's first message (a `ScriptChooser`), so different tasks can play different
 *   scripts. A chooser that has none for it kills the session as a `Fail` step would.
 */
import { randomUUID } from 'node:crypto'
import { contextWindowFor } from '../../shared/contextWindow'
import type { ToolInput } from '../../shared/domain'
import { AsyncQueue } from './async-queue'
import type { AgentSession, AgentSessionOptions, AgentSessionSettings } from './backend'
import { GLADE_SERVER } from './glade-tools'
import { createMcpToolCaller, type McpToolCaller } from './mcp-tool-caller'
import { COMPACT_COMMAND, RESUME_PROMPT } from './runner'
import {
  DEFAULT_COMPACT_TURN,
  ScriptStepKind,
  type AgentScript,
  type CompactStep,
  type ScriptStep,
  type ScriptTurn,
} from './scripts'

/** Picks the script a session plays from the first message sent to it. Throws when it has none for that message. */
export type ScriptChooser = (firstMessage: string) => AgentScript

export interface ScriptedSessionOptions {
  /** The script to play, or how to pick it from the first message. */
  readonly script: AgentScript | ScriptChooser
  readonly session: AgentSessionOptions
  /** Makes the session's ids: its SDK session id (unless it resumes one) and the prefix of its tool call ids. */
  readonly newId?: () => string
  /**
   * Called once for each message sent, when the session has nothing left to do for it for now: its turn ended (or
   * never ran, the session having failed or closed), or it's waiting to be interrupted.
   */
  readonly onIdle?: () => void
}

/** The name the SDK gives one of Glade's tools, e.g. `mcp__glade__set_title`. */
export function gladeToolName(tool: string): string {
  return `mcp__${GLADE_SERVER}__${tool}`
}

/**
 * The model's token usage on each assistant message, and the turn's on its `result`. Made up, but realistic. An
 * assistant message reads the rest of the context the session has used from the cache.
 */
const MESSAGE_USAGE = {
  input_tokens: 10,
  cache_creation_input_tokens: 1272,
  cache_read_input_tokens: 21564,
  output_tokens: 1,
}
/** The context a session has used until a step fills or compacts it: 22,846 tokens. */
const INITIAL_CONTEXT_TOKENS =
  MESSAGE_USAGE.input_tokens + MESSAGE_USAGE.cache_creation_input_tokens + MESSAGE_USAGE.cache_read_input_tokens
/** How long a compaction says it took. */
const COMPACT_DURATION_MS = 21_483
const TURN_USAGE = {
  input_tokens: 28,
  cache_creation_input_tokens: 9443,
  cache_read_input_tokens: 58094,
  output_tokens: 553,
}
/** What each turn adds to the session's estimated cost. */
const TURN_COST_USD = 0.0285

/** The tool result the SDK gives a call cut short by an interrupt. */
export const REJECTED_TOOL_OUTPUT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."

/** The session failed or was closed: stop playing anything. */
class Stopped extends Error {}

/** A running turn's state. */
interface TurnState {
  readonly number: number
  readonly startedAt: number
  /** Resolves (never rejects) when the turn is interrupted. */
  readonly interrupted: Promise<void>
  readonly interrupt: () => void
  isInterrupted: boolean
  /** The assistant message id the next block belongs to: a new one after each round of tool results. */
  messageId: number
  /** Whether a tool result came since the last assistant block, so the next block starts a new message. */
  afterResult: boolean
  /** Tool calls without a result yet, by script id: their SDK id and parent. */
  readonly running: Map<string, { readonly sdkId: string; readonly parent: string | null }>
  /** The last top-level text, for the `result`. */
  lastText: string
  /** Whether `onIdle` has been called for this turn. */
  idle: boolean
  /** The uuids of the messages the turn has taken: the one that started it, then any folded into it. */
  readonly uuids: string[]
  /** The script turns of messages folded into the turn that it hasn't started playing yet. */
  readonly folded: ScriptTurn[]
}

export class ScriptedSession implements AgentSession {
  private readonly stream = new AsyncQueue<unknown>()
  readonly messages: AsyncIterable<unknown> = this.stream
  private readonly sessionId: string
  /** Makes tool call ids unique to this session, since a task's calls share one log across sessions. */
  private readonly idPrefix: string
  private turnsRun = 0
  /** The script the session plays: picked on its first message. */
  private script: AgentScript | null = null
  private turn: TurnState | null = null
  private queue: Promise<void> = Promise.resolve()
  private stopped = false
  private costUsd = 0
  /** Runs the session's in-process MCP tools, as the Claude Code process would. */
  private readonly tools: McpToolCaller
  /** The model the session runs on: its start's, until `configure` changes it for the turns after. */
  private model: string
  /** The context the session has used, in tokens, as its assistant messages report it. */
  private contextTokens = INITIAL_CONTEXT_TOKENS

  constructor(private readonly options: ScriptedSessionOptions) {
    this.model = options.session.model
    const newId = options.newId ?? randomUUID
    this.sessionId = options.session.resumeSessionId ?? newId()
    this.idPrefix = newId().replaceAll('-', '').slice(0, 8)
    this.tools = createMcpToolCaller(options.session.mcpServers)
  }

  send(text: string, uuid: string): void {
    const script = this.chooseScript(text)
    const turn = script === null ? [] : this.turnFor(script, text)
    const playing = this.turn
    if (playing !== null && !playing.isInterrupted && !this.stopped) {
      playing.uuids.push(uuid)
      playing.folded.push(turn.filter((step) => step.kind !== ScriptStepKind.Init))
      // The folded message has nothing of its own left to do: the turn it joined goes idle for itself.
      this.options.onIdle?.()
      return
    }
    const number = this.turnsRun
    this.queue = this.queue.then(() => this.play(turn, number, uuid))
  }

  /** The script turn a message runs: see the module comment. */
  private turnFor(script: AgentScript, text: string): ScriptTurn {
    if (text === COMPACT_COMMAND) return script.compactTurn ?? DEFAULT_COMPACT_TURN
    this.turnsRun += 1
    if (text === RESUME_PROMPT && script.resumeTurn !== undefined) return script.resumeTurn
    return script.turns[Math.min(this.turnsRun - 1, script.turns.length - 1)] ?? []
  }

  /** The script to play, picked on the first message; null, having killed the session, when there's none for it. */
  private chooseScript(firstMessage: string): AgentScript | null {
    if (this.script !== null || this.stopped) return this.script
    const { script } = this.options
    try {
      this.script = typeof script === 'function' ? script(firstMessage) : script
    } catch (error) {
      this.die(error instanceof Error ? error : new Error(String(error)))
    }
    return this.script
  }

  configure({ model }: AgentSessionSettings): void {
    this.queue = this.queue.then(() => {
      this.model = model
    })
  }

  interrupt(): Promise<void> {
    this.turn?.interrupt()
    return Promise.resolve()
  }

  close(): void {
    this.stopped = true
    this.turn?.interrupt()
    this.stream.end()
    void this.tools.close()
  }

  private push(message: Record<string, unknown>): void {
    this.stream.push({ ...message, session_id: this.sessionId })
  }

  private async play(steps: ScriptTurn, number: number, uuid: string): Promise<void> {
    if (this.stopped) {
      this.options.onIdle?.()
      return
    }
    let interrupt = (): void => undefined
    const interrupted = new Promise<void>((resolve) => {
      interrupt = resolve
    })
    const turn: TurnState = {
      number,
      startedAt: Date.now(),
      interrupted,
      interrupt: () => {
        turn.isInterrupted = true
        interrupt()
      },
      isInterrupted: false,
      messageId: 1,
      afterResult: false,
      running: new Map(),
      lastText: '',
      idle: false,
      uuids: [uuid],
      folded: [],
    }
    this.turn = turn
    // Functions, so the checks aren't narrowed away: an interrupt or a close can land during any await.
    const wasInterrupted = (): boolean => turn.isInterrupted
    const isLive = (): boolean => !this.stopped
    try {
      let left: readonly ScriptStep[] = steps
      while (!wasInterrupted()) {
        // A message folded into the turn replaces what it had left to do.
        left = turn.folded.shift() ?? left
        const [step, ...rest] = left
        if (step === undefined) break
        left = rest
        await this.step(turn, step, uuid)
      }
      if (wasInterrupted() && isLive()) this.abort(turn)
    } catch (error) {
      // A Glade tool couldn't be called at all (the session has no Glade server): that kills the session, loudly.
      if (!(error instanceof Stopped) && isLive()) {
        this.die(error instanceof Error ? error : new Error(String(error)))
      }
    } finally {
      this.turn = null
      this.idle(turn)
    }
  }

  private idle(turn: TurnState): void {
    if (turn.idle) return
    turn.idle = true
    this.options.onIdle?.()
  }

  private async step(turn: TurnState, step: ScriptStep, uuid: string): Promise<void> {
    switch (step.kind) {
      case ScriptStepKind.Init:
        this.init()
        return
      case ScriptStepKind.Text:
        this.assistant(
          turn,
          { type: 'text', text: step.text },
          step.parent === undefined ? null : this.sdkToolId(turn, step.parent),
          uuid,
        )
        if (step.parent === undefined) turn.lastText = step.text
        return
      case ScriptStepKind.ToolUse:
        this.toolUse(turn, step.id, step.name, step.input, step.parent ?? null, uuid)
        return
      case ScriptStepKind.ToolResult:
        this.toolResult(turn, step.id, step.output, step.isError ?? false)
        return
      case ScriptStepKind.GladeTool: {
        this.toolUse(turn, step.id, gladeToolName(step.tool), step.input, null, uuid)
        const outcome = await this.tools.call(gladeToolName(step.tool), step.input)
        this.toolResult(turn, step.id, outcome.output, outcome.isError)
        return
      }
      case ScriptStepKind.Result:
        this.costUsd += TURN_COST_USD
        this.result(turn, turn.uuids, {
          subtype: 'success',
          is_error: step.isError ?? false,
          result: step.text ?? turn.lastText,
          terminal_reason: step.terminalReason ?? 'completed',
          ...(step.errors === undefined ? {} : { errors: step.errors }),
          ...step.extra,
        })
        return
      case ScriptStepKind.Emit:
        this.stream.push(step.message)
        return
      case ScriptStepKind.Delay:
        await this.wait(turn, step.ms)
        return
      case ScriptStepKind.Fail:
        this.die(new Error(step.message))
        throw new Stopped()
      case ScriptStepKind.WaitForInterrupt:
        this.idle(turn)
        await turn.interrupted
        return
      case ScriptStepKind.FillContext:
        this.contextTokens = Math.round(contextWindowFor(this.model) * step.fraction)
        return
      case ScriptStepKind.Compact:
        await this.compact(turn, step)
        return
    }
  }

  /**
   * Compacts the context, streaming what the SDK does (`docs/sdk-notes.md`, Compaction). An interrupt while it compacts
   * leaves the context as it was.
   */
  private async compact(turn: TurnState, step: CompactStep): Promise<void> {
    const postTokens = step.postTokens ?? Math.round(this.contextTokens / 5)
    const metadata = {
      trigger: step.trigger ?? 'manual',
      pre_tokens: this.contextTokens,
      post_tokens: postTokens,
      duration_ms: COMPACT_DURATION_MS,
    }
    this.push({ type: 'system', subtype: 'status', status: 'compacting', uuid: randomUUID() })
    if (step.ms !== undefined) await this.wait(turn, step.ms)
    if (turn.isInterrupted) return
    this.contextTokens = postTokens
    this.push({ type: 'system', subtype: 'status', status: null, compact_result: 'success', uuid: randomUUID() })
    this.push({ type: 'system', subtype: 'compact_boundary', compact_metadata: metadata, uuid: randomUUID() })
    this.push({
      type: 'user',
      parent_tool_use_id: null,
      isSynthetic: true,
      message: {
        role: 'user',
        content: 'This session is being continued from a previous conversation that ran out of context. Summary: …',
      },
    })
  }

  /** The session is over: its stream throws `error`. */
  private die(error: Error): void {
    this.stopped = true
    this.stream.fail(error)
  }

  /** Waits `ms`, or until the turn is interrupted. */
  private async wait(turn: TurnState, ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    const elapsed = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
    })
    await Promise.race([elapsed, turn.interrupted])
    clearTimeout(timer)
  }

  private init(): void {
    const { cwd, mcpServers } = this.options.session
    this.push({
      type: 'system',
      subtype: 'init',
      cwd,
      model: this.model,
      permissionMode: 'bypassPermissions',
      apiKeySource: 'none',
      tools: [
        'Agent',
        'Bash',
        'Edit',
        'Glob',
        'Grep',
        'Read',
        'Write',
        ...Object.keys(mcpServers).map((name) => `mcp__${name}`),
      ],
      mcp_servers: Object.keys(mcpServers).map((name) => ({ name, status: 'connected', source: 'sdk' })),
      agents: ['general-purpose', 'Explore', 'Plan'],
      uuid: randomUUID(),
    })
  }

  private assistant(turn: TurnState, block: Record<string, unknown>, parent: string | null, uuid: string): void {
    if (turn.afterResult) {
      turn.messageId += 1
      turn.afterResult = false
    }
    const extra = block.type === 'tool_use' ? { tool_use_meta: [{ id: block.id, display_name: block.name }] } : {}
    this.push({
      type: 'assistant',
      parent_tool_use_id: parent,
      uuid: randomUUID(),
      user_message_uuid: uuid,
      message: {
        id: `msg_${this.idPrefix}_${String(turn.number)}_${String(turn.messageId)}`,
        model: this.model,
        stop_reason: null,
        content: [block],
        usage: {
          ...MESSAGE_USAGE,
          cache_read_input_tokens: this.contextTokens - INITIAL_CONTEXT_TOKENS + MESSAGE_USAGE.cache_read_input_tokens,
        },
      },
      ...extra,
    })
  }

  private sdkToolId(turn: TurnState, id: string): string {
    return `toolu_${this.idPrefix}_${String(turn.number)}_${id}`
  }

  private toolUse(
    turn: TurnState,
    id: string,
    name: string,
    input: ToolInput,
    parent: string | null,
    uuid: string,
  ): void {
    const sdkId = this.sdkToolId(turn, id)
    const sdkParent = parent === null ? null : this.sdkToolId(turn, parent)
    turn.running.set(id, { sdkId, parent: sdkParent })
    this.assistant(turn, { type: 'tool_use', id: sdkId, name, input }, sdkParent, uuid)
  }

  private toolResult(turn: TurnState, id: string, output: string, isError: boolean): void {
    const call = turn.running.get(id)
    turn.running.delete(id)
    this.pushToolResult(call?.sdkId ?? this.sdkToolId(turn, id), call?.parent ?? null, output, isError)
    turn.afterResult = true
  }

  private pushToolResult(sdkId: string, parent: string | null, output: string, isError: boolean): void {
    this.push({
      type: 'user',
      parent_tool_use_id: parent,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: sdkId, content: output, is_error: isError }],
      },
      tool_use_result: { stdout: isError ? '' : output, stderr: isError ? output : '', interrupted: false },
    })
  }

  private result(turn: TurnState, uuids: readonly string[], fields: Record<string, unknown>): void {
    const durationMs = Date.now() - turn.startedAt
    this.push({
      type: 'result',
      num_turns: turn.messageId,
      stop_reason: 'end_turn',
      duration_ms: durationMs,
      duration_api_ms: durationMs,
      total_cost_usd: this.costUsd,
      usage: TURN_USAGE,
      modelUsage: this.modelUsage(),
      permission_denials: [],
      user_message_uuids: uuids,
      ...fields,
    })
  }

  /** The session's usage by model, as a `result` reports it: all of it on the session's model. */
  private modelUsage(): Record<string, unknown> {
    const { model } = this.options.session
    return {
      [model]: {
        inputTokens: TURN_USAGE.input_tokens,
        outputTokens: TURN_USAGE.output_tokens,
        cacheReadInputTokens: TURN_USAGE.cache_read_input_tokens,
        cacheCreationInputTokens: TURN_USAGE.cache_creation_input_tokens,
        webSearchRequests: 0,
        costUSD: this.costUsd,
        contextWindow: contextWindowFor(model),
        maxOutputTokens: 32_000,
      },
    }
  }

  /** Ends an interrupted turn as the SDK does. */
  private abort(turn: TurnState): void {
    const inTool = turn.running.size > 0
    for (const { sdkId, parent } of turn.running.values())
      this.pushToolResult(sdkId, parent, REJECTED_TOOL_OUTPUT, true)
    turn.running.clear()
    const marker = inTool ? '[Request interrupted by user for tool use]' : '[Request interrupted by user]'
    this.push({
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: marker }] },
    })
    this.result(turn, [''], {
      subtype: 'error_during_execution',
      is_error: true,
      result: '',
      terminal_reason: inTool ? 'aborted_tools' : 'aborted_streaming',
      errors: [],
      usage: MESSAGE_USAGE,
    })
  }
}
