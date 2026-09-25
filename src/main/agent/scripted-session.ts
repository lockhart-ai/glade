/**
 * Plays an agent script (see `./scripts`) as an `AgentSession`: each message sent runs the script's next turn, whose
 * steps become the SDK messages a real session would stream (shapes from `docs/sdk-notes.md` §2). Nothing runs a
 * model. The test modes' agent backend (`./test-mode-backend`) starts these.
 *
 * - Turns run one after another, in the order their messages were sent. The runner's `RESUME_PROMPT`, and its messages
 *   answering a question or deciding permission requests the app quit on, run the script's resume turn, if it has one. `/compact` runs its compact turn (by default `DEFAULT_COMPACT_TURN`), which
 *   isn't one of the script's turns: the message after it runs the next of those.
 * - Each assistant message reports the context the session has used: 22,846 tokens unless a step fills it, and what
 *   a compaction left after one.
 * - A message sent while a turn is playing is folded into it, as the SDK folds a message pushed mid-turn: before its
 *   next step, the turn drops the steps it has left and plays the script's next turn instead (without its init), and
 *   its `result` answers every message it took.
 * - An interrupt ends the running turn the way the SDK does: tool calls still running get a "rejected" result, then an
 *   interrupt marker and an `error_during_execution` result (`aborted_tools` if a call was running, else
 *   `aborted_streaming`).
 * - A `Wake` step has the agent start a turn of its own later, with no message sent (see `ScriptStepKind.Wake`). It
 *   waits for the turn playing to end, like a message sent meanwhile, and a message sent while it plays is folded in.
 * - A `Monitor` call, or a `Bash` call with `run_in_background`, starts a background task as the SDK does
 *   (`docs/sdk-notes.md` §13): a `task_started` (`local_bash`) after the call, and its result's `tool_use_result`
 *   names the task. A `Wake` step can then have it print an event or end; `stopTask` stops it, with the SDK's
 *   notification (a stopped task never wakes the agent). A `ScheduleWakeup` or `CronCreate` call schedules a job, and
 *   `CronDelete` (or `ScheduleWakeup` with `stop`) deletes one; each turn's end tells the session's `Stop` hook the jobs
 *   it has (`hooks.onTurnEnded`). Each wake, and each job firing, is first put to the prompt hook (`hooks.onPrompt`),
 *   which can turn a job's fire away.
 * - An `Agent` (or `Task`) call starts its subagent as a task, as the SDK does: a `task_started` after the call, and a
 *   `task_updated` and `task_notification` (completed, or failed for an error) just before its result.
 * - A `Background` step starts a subagent in the background (see `ScriptStepKind.Background`): its `Agent` call returns
 *   at once, and the subagent plays its steps alongside the session's turns, until it ends and notifies the agent, which
 *   may then start a turn of its own. `stopTask` stops it by its task id; closing the session stops it without a word.
 * - A `Permission` step asks the runner about its call (`onToolPermission`) in the ask mode, as Claude Code asks
 *   `canUseTool`, and plays the call's result once it's allowed, or its denial as an error result. In Allow all, or
 *   after `configure` switches to it, it runs without asking. So does a call a rule covers (`scriptedRuleCovers`): one
 *   the session started with (`allowedRules`), or one an answer added (Allow for this task).
 * - A `ControlTool` step calls one of Glade's control tools (`glade-control`) through its real handler, once allowed:
 *   in the ask mode it asks the runner first, as Claude Code does for an MCP tool that isn't in its allowed tools, with
 *   the SDK saying the tool is on the in-process `glade-control` server. Its input can depend on the session's folder,
 *   for a call that names files in it by absolute path.
 * - A `Fail` step kills the session: its message stream throws, and it plays nothing more.
 * - The script can be picked by the session's first message (a `ScriptChooser`), so different tasks can play different
 *   scripts. A chooser that has none for it kills the session as a `Fail` step would.
 */
import { randomUUID } from 'node:crypto'
import { contextWindowFor } from '../../shared/contextWindow'
import { PermissionMode, type PermissionRule, type ToolInput } from '../../shared/domain'
import { AsyncQueue } from './async-queue'
import {
  PromptVerdict,
  ToolPermissionBehavior,
  type AgentSession,
  type AgentSessionOptions,
  type AgentSessionSettings,
  type McpServerOrigin,
  type ToolPermissionAnswer,
} from './backend'
import { CONTROL_SERVER } from '../control/names'
import { GLADE_SERVER, GladeTool } from './glade-tools'
import { createMcpToolCaller, type McpToolCaller, type McpToolOutcome } from './mcp-tool-caller'
import {
  ANSWERED_AFTER_RESTART_PROMPT,
  COMPACT_COMMAND,
  PERMISSIONS_DECIDED_AFTER_RESTART_PROMPT,
  RESUME_PROMPT,
} from './runner'
import { BLOCKED_PROMPT_REASON, NO_ONE_TO_ASK, sdkPermissionMode } from './sdk-backend'
import {
  DEFAULT_COMPACT_TURN,
  ScriptStepKind,
  type AgentScript,
  type AskStep,
  type BackgroundStep,
  type CompactStep,
  type ControlToolStep,
  type PermissionStep,
  type ScriptStep,
  type ScriptTurn,
  type WakeStep,
  WakeCause,
} from './scripts'

/** What makes a command more than one: Claude Code splits these apart, and asks about the parts a rule doesn't cover. */
const COMPOUND = /&&|\|\||[;|&\n`]|\$\(/

/**
 * Whether a permission rule lets a call through, as Claude Code decides it, closely enough for scripts: a rule without
 * content covers every call to its tool; a `Bash` rule's content covers the command itself, or, ending in ` *` or `:*`,
 * every command that is its prefix alone or followed by a space and more. A compound command is never covered, since
 * Claude Code would ask about its parts, and the scripts don't split it.
 */
export function scriptedRuleCovers(rule: PermissionRule, toolName: string, input: ToolInput): boolean {
  if (rule.toolName !== toolName) return false
  const content = rule.ruleContent ?? ''
  if (content === '') return true
  const command = input.command
  if (toolName !== 'Bash' || typeof command !== 'string' || COMPOUND.test(command)) return false
  const prefix = /^(.*?)(?: \*|:\*)$/.exec(content)?.[1]
  if (prefix === undefined) return command === content
  return command === prefix || command.startsWith(`${prefix} `)
}

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
  /**
   * Called when a `Wake` step schedules a turn the agent starts on its own, which then counts as a message sent: `onIdle`
   * is called once for it too, when that turn ends or can't play.
   */
  readonly onWake?: () => void
}

/** The name the SDK gives one of Glade's tools, e.g. `mcp__glade__set_title`. */
export function gladeToolName(tool: string): string {
  return `mcp__${GLADE_SERVER}__${tool}`
}

/** The name the SDK gives one of Glade's control tools, e.g. `mcp__glade-control__list_tasks`. */
export function controlToolName(tool: string): string {
  return `mcp__${CONTROL_SERVER}__${tool}`
}

/** What the SDK says of the server a control tool is on: Glade's own in-process one. */
const CONTROL_ORIGIN: McpServerOrigin = { name: CONTROL_SERVER, source: 'sdk' }

/** What deciding a call reads of it. */
type PermissionCallStep = Omit<PermissionStep, 'kind' | 'output'>

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

/** The text of a background subagent's `Agent` call result (`docs/sdk-notes.md`, "Background subagents"). */
export const LAUNCHED_OUTPUT =
  'Async agent launched successfully. The agent is working in the background. You will be notified automatically ' +
  'when it completes.'

/** The tools that start a subagent: `Agent` in `tool_use` (the init tools list calls it `Task`). */
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task'])

/** How many tokens a background subagent says it has used, per tool call it has made. Made up. */
const SUBAGENT_TOKENS_PER_CALL = 1_150

/** The session failed or was closed: stop playing anything. */
class Stopped extends Error {}

/** A running turn's state. */
interface TurnState {
  /** Tells the turn's ids apart: the number of the script turn it plays, or `wake-<n>` for one the agent started. */
  readonly key: string
  /** Whether the agent started the turn on its own (a `Wake`), not a message. */
  readonly woken: boolean
  /**
   * Whether its `result` says a task notification started it (`origin: task-notification`): a turn the agent started
   * on its own, but for a scheduled one, whose `result` has no `origin`.
   */
  readonly notified: boolean
  readonly startedAt: number
  /** Resolves (never rejects) when the turn is interrupted. */
  readonly interrupted: Promise<void>
  readonly interrupt: () => void
  isInterrupted: boolean
  /** The assistant message id the next block belongs to: a new one after each round of tool results. */
  messageId: number
  /** Whether a tool result came since the last assistant block, so the next block starts a new message. */
  afterResult: boolean
  /** Tool calls without a result yet, by script id. */
  readonly running: Map<string, RunningCall>
  /** The last top-level text, for the `result`. */
  lastText: string
  /** Whether `onIdle` has been called for this turn. */
  idle: boolean
  /** The uuids of the messages the turn has taken: the one that started it (if one did), then any folded into it. */
  readonly uuids: string[]
  /** The script turns of messages folded into the turn that it hasn't started playing yet. */
  readonly folded: ScriptTurn[]
}

/** A tool call waiting on its result. */
interface RunningCall {
  readonly sdkId: string
  readonly parent: string | null
  readonly name: string
  readonly input: ToolInput
}

/** A background task a `Monitor` or `Bash` call started (see `ScriptedSession.startWatch`). */
interface Watch {
  /** The SDK's id for its task. */
  readonly taskId: string
  /** The SDK id of the call that started it. */
  readonly toolUseId: string
  readonly description: string
  /** Whether it's still running: it hasn't ended or been stopped. */
  running: boolean
}

/** A job a `ScheduleWakeup` or `CronCreate` call scheduled, as the SDK lists it (`SessionJob`). */
interface ScheduledJob {
  /** The SDK id of the call that scheduled it. */
  readonly toolUseId: string
  readonly id: string
  readonly schedule: string
  readonly recurring: boolean
  readonly prompt: string
  /** Whether it's a `ScheduleWakeup`'s. */
  readonly wakeup: boolean
}

/** How a background task ends, as the SDK's `task_notification` says. */
type WatchStatus = 'completed' | 'failed' | 'stopped'

/** `ScheduleWakeup` clamps its delay to 60–3600 seconds, and fires on a whole minute (`docs/sdk-notes.md` §11). */
const WAKEUP_MIN_DELAY_S = 60
const WAKEUP_MAX_DELAY_S = 3600
const MINUTE_MS = 60_000

/** A `Monitor`'s timeout when the call gives none: Claude Code's default. */
const DEFAULT_MONITOR_TIMEOUT_MS = 300_000

/** Whether a call starts a background task: a `Monitor`, or a `Bash` command with `run_in_background`. */
function startsWatch(name: string, input: ToolInput): boolean {
  return name === 'Monitor' || (name === 'Bash' && input.run_in_background === true)
}

/** A `<task-notification>` for a monitor's event, as the SDK words a wake's prompt (`docs/sdk-notes.md` §13). */
export function eventNotice(taskId: string, description: string, event: string): string {
  return [
    '<task-notification>',
    `<task-id>${taskId}</task-id>`,
    `<summary>Monitor event: "${description}"</summary>`,
    `<event>${event}</event>`,
    '</task-notification>',
  ].join('\n')
}

/** A `<task-notification>` for a background task's ending, with the monitor's last event, if any. */
export function endNotice(taskId: string, toolUseId: string, status: string, summary: string, event?: string): string {
  return [
    '<task-notification>',
    `<task-id>${taskId}</task-id>`,
    `<tool-use-id>${toolUseId}</tool-use-id>`,
    `<output-file>tasks/${taskId}.output</output-file>`,
    `<status>${status}</status>`,
    `<summary>${summary}</summary>`,
    ...(event === undefined ? [] : [`<event>${event}</event>`]),
    '</task-notification>',
  ].join('\n')
}

/** A new turn's state: see `TurnState`. */
function newTurnState(key: string, uuid: string | null, notified = uuid === null): TurnState {
  let interrupt = (): void => undefined
  const interrupted = new Promise<void>((resolve) => {
    interrupt = resolve
  })
  const turn: TurnState = {
    key,
    woken: uuid === null,
    notified,
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
    uuids: uuid === null ? [] : [uuid],
    folded: [],
  }
  return turn
}

/** A background subagent, as the SDK names it. */
interface BackgroundTask {
  /** The SDK's id for its task. */
  readonly taskId: string
  /** Its `Agent` call's SDK id. */
  readonly agentId: string
  readonly description: string
}

export class ScriptedSession implements AgentSession {
  private readonly stream = new AsyncQueue<unknown>()
  readonly messages: AsyncIterable<unknown> = this.stream
  private readonly sessionId: string
  /** Makes tool call ids unique to this session, since a task's calls share one log across sessions. */
  private readonly idPrefix: string
  private turnsRun = 0
  /** How many turns the agent has started on its own. */
  private wakes = 0
  /** How many subagents the session has started, in the background or not: what numbers their task ids. */
  private backgrounds = 0
  /** The SDK task id of each subagent a turn waits on, by its `Agent` call's SDK id, until its call's result. */
  private readonly foreground = new Map<string, string>()
  /** The background subagents playing, by their SDK task id: each plays as a turn of its own, to interrupt. */
  private readonly running = new Map<string, TurnState>()
  /** The background tasks `Monitor` and `Bash` calls started, by the SDK id of the call. */
  private readonly watches = new Map<string, Watch>()
  /** The jobs the session has scheduled, in the order it scheduled them. */
  private readonly jobs: ScheduledJob[] = []
  /** How many background tasks and jobs the session has started: what numbers their ids. */
  private scheduled = 0
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
  /** The permission mode the session runs in: its start's, until `configure` changes it. */
  private permissionMode: PermissionMode
  /** The context the session has used, in tokens, as its assistant messages report it. */
  private contextTokens = INITIAL_CONTEXT_TOKENS
  /** The permission rules the session lets calls through by: its start's, and those answers added since. */
  private readonly rules: PermissionRule[]

  constructor(private readonly options: ScriptedSessionOptions) {
    this.model = options.session.model
    this.permissionMode = options.session.permissionMode
    this.rules = [...(options.session.allowedRules ?? [])]
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
    const key = String(this.turnsRun)
    this.queue = this.queue.then(() => this.play(turn, key, uuid))
  }

  /** The script turn a message runs: see the module comment. */
  private turnFor(script: AgentScript, text: string): ScriptTurn {
    if (text === COMPACT_COMMAND) return script.compactTurn ?? DEFAULT_COMPACT_TURN
    this.turnsRun += 1
    const resuming =
      text === RESUME_PROMPT ||
      text.startsWith(ANSWERED_AFTER_RESTART_PROMPT) ||
      text.startsWith(PERMISSIONS_DECIDED_AFTER_RESTART_PROMPT)
    if (resuming && script.resumeTurn !== undefined) return script.resumeTurn
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

  configure({ model, permissionMode }: AgentSessionSettings): void {
    // The permission mode applies from the next tool call, even mid-turn; the model from the next turn.
    this.permissionMode = permissionMode
    this.queue = this.queue.then(() => {
      this.model = model
    })
  }

  interrupt(): Promise<void> {
    this.turn?.interrupt()
    return Promise.resolve()
  }

  /**
   * Stops a background subagent by its task id. A foreground subagent in a script plays out whatever happens: there's
   * no stopping one on its own.
   */
  stopTask(sdkTaskId: string): Promise<void> {
    this.running.get(sdkTaskId)?.interrupt()
    const watch = [...this.watches.values()].find(({ taskId }) => taskId === sdkTaskId)
    if (watch?.running === true && !this.stopped) {
      watch.running = false
      this.endWatch(watch, 'stopped', watch.description)
    }
    return Promise.resolve()
  }

  close(): void {
    this.stopped = true
    this.turn?.interrupt()
    for (const subagent of this.running.values()) subagent.interrupt()
    this.stream.end()
    void this.tools.close()
  }

  private push(message: Record<string, unknown>): void {
    this.stream.push({ ...message, session_id: this.sessionId })
  }

  /**
   * Plays a turn: one a message started (`uuid` is its), or, for a null `uuid`, one the agent started on its own, which
   * a task notification started unless it's `scheduled`.
   */
  private async play(steps: ScriptTurn, key: string, uuid: string | null, scheduled = false): Promise<void> {
    if (this.stopped) {
      this.options.onIdle?.()
      return
    }
    const turn = newTurnState(key, uuid, uuid === null && !scheduled)
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

  private async step(turn: TurnState, step: ScriptStep, uuid: string | null): Promise<void> {
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
        this.toolResult(turn, step.id, step.output, step.isError ?? false, step.details)
        return
      case ScriptStepKind.GladeTool: {
        this.toolUse(turn, step.id, gladeToolName(step.tool), step.input, null, uuid)
        const outcome = await this.tools.call(gladeToolName(step.tool), step.input)
        this.toolResult(turn, step.id, outcome.output, outcome.isError)
        return
      }
      case ScriptStepKind.Result:
        // The session's `Stop` hook runs as the turn ends, before its `result`.
        this.options.session.hooks?.onTurnEnded(
          this.jobs.map(({ id, schedule, recurring, prompt }) => ({ id, schedule, recurring, prompt })),
        )
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
      case ScriptStepKind.Ask:
        await this.ask(turn, step, uuid)
        return
      case ScriptStepKind.Wake:
        this.wake(turn, step)
        return
      case ScriptStepKind.Background:
        this.background(turn, step, uuid)
        return
      case ScriptStepKind.Permission:
        await this.permission(turn, step, uuid)
        return
      case ScriptStepKind.ControlTool:
        await this.controlTool(turn, step, uuid)
        return
      case ScriptStepKind.LimitReached:
        this.push({
          type: 'rate_limit_event',
          rate_limit_info: {
            status: 'rejected',
            resetsAt: Math.ceil((Date.now() + step.resetInMs) / 1000),
            rateLimitType: 'five_hour',
          },
          uuid: randomUUID(),
        })
        return
    }
  }

  /**
   * Calls `ask` through the session's Glade server and waits for the answers: the turn is waiting on the user, so the
   * session goes idle until they answer. An interrupt cancels the call, as the SDK does, and the turn then ends as an
   * interrupted one.
   */
  /**
   * Schedules the turn a `Wake` step has the agent start on its own: `ms` from now, it waits for the turn playing then
   * to end, and plays after what the SDK streams for its cause (`WakeCause`).
   */
  private wake(turn: TurnState, step: WakeStep): void {
    this.options.onWake?.()
    const toolUseId = step.task === undefined ? undefined : this.sdkToolId(turn, step.task)
    const jobCall = step.job === undefined ? undefined : this.sdkToolId(turn, step.job)
    const cause = step.cause ?? WakeCause.TaskEnded
    setTimeout(() => {
      this.queue = this.queue.then(() => {
        this.wakes += 1
        const prompt = this.stopped ? null : this.announceWake(cause, step, toolUseId, jobCall)
        // A watch stopped, or a job deleted, meanwhile never wakes the agent.
        if (prompt === false) {
          this.options.onIdle?.()
          return
        }
        if (prompt !== null && this.options.session.hooks?.onPrompt(prompt) === PromptVerdict.Block) {
          this.turnedAway(prompt)
          this.options.onIdle?.()
          return
        }
        return this.play(step.turn, `wake-${String(this.wakes)}`, null, cause === WakeCause.Scheduled)
      })
    }, step.ms ?? 0)
  }

  /**
   * What the SDK streams before a turn the agent starts on its own, for what woke it (`docs/sdk-notes.md` §11 and §13).
   * Answers the prompt the wake puts to the prompt hook; null when it names no task or job of the session's (a wake
   * as the SDK streams it, without the hook); false when its watch was stopped, or its job deleted, meanwhile.
   */
  private announceWake(
    cause: WakeCause,
    step: WakeStep,
    toolUseId: string | undefined,
    jobCall: string | undefined,
  ): string | null | false {
    const watch = toolUseId === undefined ? undefined : this.watches.get(toolUseId)
    switch (cause) {
      case WakeCause.TaskEnded: {
        if (watch === undefined) {
          this.notify(step.summary ?? '', toolUseId)
          return null
        }
        if (!watch.running) return false
        watch.running = false
        const status = step.outcome ?? 'completed'
        const summary = step.summary ?? ''
        this.endWatch(watch, status, summary)
        return endNotice(watch.taskId, watch.toolUseId, status, summary, step.event)
      }
      case WakeCause.MonitorEvent:
        if (watch === undefined) return null
        return watch.running ? eventNotice(watch.taskId, watch.description, step.event ?? '') : false
      case WakeCause.Scheduled: {
        const index = this.jobs.findIndex((job) => job.toolUseId === jobCall)
        const job = this.jobs[index]
        if (jobCall !== undefined && job === undefined) return false
        // The job's prompt runs as a command of the SDK's own: only its lifecycle shows, never the prompt.
        this.push({ type: 'command_lifecycle', command_uuid: randomUUID(), state: 'started', uuid: randomUUID() })
        if (job === undefined) return null
        if (!job.recurring) this.jobs.splice(index, 1)
        return job.prompt
      }
    }
  }

  /** What the SDK streams for a prompt the prompt hook turned away: no turn, just a note and a bare `result`. */
  private turnedAway(prompt: string): void {
    this.init()
    const text = `UserPromptSubmit operation blocked by hook:\n${BLOCKED_PROMPT_REASON}\n\nOriginal prompt: ${prompt}`
    this.push({
      type: 'system',
      subtype: 'informational',
      content: text,
      level: 'warning',
      prevent_continuation: true,
      uuid: randomUUID(),
    })
    this.push({ type: 'result', subtype: 'success', is_error: false, result: text, uuid: randomUUID() })
  }

  /** What the SDK streams when a `Monitor`'s or background command's task ends (`docs/sdk-notes.md` §13). */
  private endWatch(watch: Watch, status: WatchStatus, summary: string): void {
    this.push({
      type: 'system',
      subtype: 'task_updated',
      task_id: watch.taskId,
      patch: { status: status === 'stopped' ? 'killed' : status, end_time: Date.now() },
      uuid: randomUUID(),
    })
    this.push({
      type: 'system',
      subtype: 'task_notification',
      task_id: watch.taskId,
      tool_use_id: watch.toolUseId,
      status,
      output_file: `tasks/${watch.taskId}.output`,
      summary,
      uuid: randomUUID(),
    })
  }

  /** What the SDK streams when a background task finishes, before the turn it starts (`docs/sdk-notes.md`). */
  private notify(summary: string, toolUseId: string | undefined): void {
    const taskId = `b${this.idPrefix}${String(this.wakes)}`
    const tool = toolUseId === undefined ? {} : { tool_use_id: toolUseId }
    this.push({
      type: 'system',
      subtype: 'task_updated',
      task_id: taskId,
      patch: { status: 'completed' },
      uuid: randomUUID(),
    })
    this.push({
      type: 'system',
      subtype: 'task_notification',
      task_id: taskId,
      ...tool,
      status: 'completed',
      output_file: `tasks/${taskId}.output`,
      summary,
      uuid: randomUUID(),
    })
  }

  /**
   * Starts a subagent in the background (see `ScriptStepKind.Background`): the `Agent` call, its `task_started` and its
   * "launched" result now, then the subagent plays on its own. It keeps the session busy, like a `Wake`, until it ends
   * and the turn it starts, if any, has played.
   */
  private background(turn: TurnState, step: BackgroundStep, uuid: string | null): void {
    this.backgrounds += 1
    const taskId = `a${this.idPrefix}${String(this.backgrounds)}`
    const input: ToolInput = { ...step.input, run_in_background: true }
    const agentId = this.sdkToolId(turn, step.id)
    this.assistant(turn, { type: 'tool_use', id: agentId, name: 'Agent', input }, null, uuid)
    const description = typeof input.description === 'string' ? input.description : ''
    this.push({
      type: 'system',
      subtype: 'task_started',
      task_id: taskId,
      tool_use_id: agentId,
      description,
      subagent_type: input.subagent_type ?? 'general-purpose',
      is_backgrounded: true,
      spawn_depth: 1,
      task_type: 'local_agent',
      prompt: input.prompt,
      uuid: randomUUID(),
    })
    this.push({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: agentId, content: [{ type: 'text', text: LAUNCHED_OUTPUT }] }],
      },
      tool_use_result: { isAsync: true, status: 'async_launched', agentId: taskId, description, prompt: input.prompt },
    })
    turn.afterResult = true
    this.options.onWake?.()
    const subagent = newTurnState(turn.key, null)
    // Its messages are its own: numbered apart from the turn's, which carries on meanwhile.
    subagent.messageId = 100
    this.running.set(taskId, subagent)
    void this.playBackground(subagent, step, { taskId, agentId, description })
  }

  /** Plays a background subagent's steps, then ends it (see `background`). */
  private async playBackground(subagent: TurnState, step: BackgroundStep, task: BackgroundTask): Promise<void> {
    let toolUses = 0
    // A function, so the check isn't narrowed away: Stop subagent can land during any await.
    const wasStopped = (): boolean => subagent.isInterrupted
    try {
      for (const next of step.steps) {
        if (wasStopped()) break
        await this.step(subagent, next, null)
        if (next.kind !== ScriptStepKind.ToolUse || wasStopped()) continue
        toolUses += 1
        this.push({
          type: 'system',
          subtype: 'task_progress',
          task_id: task.taskId,
          tool_use_id: task.agentId,
          description: task.description,
          usage: {
            total_tokens: SUBAGENT_TOKENS_PER_CALL * toolUses,
            tool_uses: toolUses,
            duration_ms: Date.now() - subagent.startedAt,
          },
          last_tool_name: next.name,
          uuid: randomUUID(),
        })
      }
    } catch (error) {
      if (!(error instanceof Stopped) && !this.stopped)
        this.die(error instanceof Error ? error : new Error(String(error)))
    }
    this.running.delete(task.taskId)
    if (this.stopped) {
      this.options.onIdle?.()
      return
    }
    const stopped = subagent.isInterrupted
    this.notifyEnded(task, stopped ? 'stopped' : (step.outcome ?? 'completed'), step.summary, toolUses, subagent)
    const turn = stopped ? step.stoppedTurn : step.turn
    if (turn === undefined) {
      this.options.onIdle?.()
      return
    }
    this.queue = this.queue.then(() => {
      this.wakes += 1
      return this.play(turn, `wake-${String(this.wakes)}`, null)
    })
  }

  /** What the SDK streams when a background subagent ends (`docs/sdk-notes.md`, "Background subagents"). */
  private notifyEnded(
    task: BackgroundTask,
    status: 'completed' | 'failed' | 'stopped',
    summary: string,
    toolUses: number,
    subagent: TurnState,
  ): void {
    const endTime = Date.now()
    this.push({
      type: 'system',
      subtype: 'task_updated',
      task_id: task.taskId,
      patch: { status: status === 'stopped' ? 'killed' : status, end_time: endTime },
      uuid: randomUUID(),
    })
    this.push({
      type: 'system',
      subtype: 'task_notification',
      task_id: task.taskId,
      tool_use_id: task.agentId,
      status,
      output_file: `tasks/${task.taskId}.output`,
      // A stopped subagent's notification only names it.
      summary: status === 'stopped' ? task.description : summary,
      usage: {
        total_tokens: SUBAGENT_TOKENS_PER_CALL * toolUses,
        tool_uses: toolUses,
        duration_ms: endTime - subagent.startedAt,
      },
      uuid: randomUUID(),
    })
    if (status !== 'stopped') return
    this.push({
      type: 'user',
      parent_tool_use_id: task.agentId,
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    })
  }

  /**
   * Whether a tool call may run, as Claude Code decides it: at once in Allow all, or for a call a rule covers; otherwise
   * the session goes idle and asks the runner (`onToolPermission`), however long it takes, and keeps the rule an Allow
   * for this task adds. `mcpServer` is the server the call's tool is on, as the SDK says it. Null when the turn was
   * interrupted meanwhile: the interrupt cancels the call's signal, as the SDK does.
   */
  private async permitted(
    turn: TurnState,
    call: PermissionCallStep,
    mcpServer: McpServerOrigin | null,
  ): Promise<ToolPermissionAnswer | null> {
    const covered = this.rules.some((rule) => scriptedRuleCovers(rule, call.name, call.input))
    if (this.permissionMode === PermissionMode.AllowAll || covered) {
      return { behavior: ToolPermissionBehavior.Allow, byUser: false }
    }
    this.idle(turn)
    const cancel = new AbortController()
    void turn.interrupted.then(() => {
      cancel.abort()
    })
    const agentId = call.parent === undefined ? null : (call.agentId ?? `a${this.idPrefix}${call.parent}`)
    const handler = this.options.session.onToolPermission
    const answer: ToolPermissionAnswer =
      handler === undefined
        ? { behavior: ToolPermissionBehavior.Deny, message: NO_ONE_TO_ASK, byUser: false }
        : await handler({
            toolName: call.name,
            input: call.input,
            toolUseId: this.sdkToolId(turn, call.id),
            agentId,
            title: call.title ?? null,
            displayName: call.name,
            description: call.description ?? null,
            suggestions: call.suggestions ?? [],
            defaultToNo: call.defaultToNo ?? false,
            suppressAlwaysAllowRule: false,
            mcpServer,
            matchedAskRule: false,
            signal: cancel.signal,
          })
    if (turn.isInterrupted) return null
    if (answer.behavior === ToolPermissionBehavior.Allow && answer.rule !== undefined) this.rules.push(answer.rule)
    return answer
  }

  /**
   * Makes a tool call that asks permission first (see `ScriptStepKind.Permission`), then plays the call's result, or
   * its denial. An interrupt while it waits ends the turn as an interrupted one.
   */
  private async permission(turn: TurnState, step: PermissionStep, uuid: string | null): Promise<void> {
    this.toolUse(turn, step.id, step.name, step.input, step.parent ?? null, uuid)
    const answer = await this.permitted(turn, step, null)
    if (answer === null) return
    switch (answer.behavior) {
      case ToolPermissionBehavior.Allow:
        this.toolResult(turn, step.id, step.output, false)
        return
      case ToolPermissionBehavior.Deny:
        this.toolResult(turn, step.id, answer.message, true)
        return
    }
  }

  /**
   * Calls one of Glade's control tools (see `ScriptStepKind.ControlTool`): it asks permission as any MCP tool not in the
   * session's allowed tools does, on the in-process `glade-control` server, and once allowed runs through the tool's
   * real handler.
   */
  private async controlTool(turn: TurnState, step: ControlToolStep, uuid: string | null): Promise<void> {
    const name = controlToolName(step.tool)
    const input = typeof step.input === 'function' ? step.input(this.options.session.cwd) : step.input
    this.toolUse(turn, step.id, name, input, null, uuid)
    const answer = await this.permitted(turn, { id: step.id, name, input }, CONTROL_ORIGIN)
    if (answer === null) return
    switch (answer.behavior) {
      case ToolPermissionBehavior.Allow: {
        const outcome = await this.tools.call(name, input)
        if (!turn.isInterrupted) this.toolResult(turn, step.id, outcome.output, outcome.isError)
        return
      }
      case ToolPermissionBehavior.Deny:
        this.toolResult(turn, step.id, answer.message, true)
        return
    }
  }

  private async ask(turn: TurnState, step: AskStep, uuid: string | null): Promise<void> {
    const name = gladeToolName(GladeTool.Ask)
    const input = { questions: step.questions }
    this.toolUse(turn, step.id, name, input, null, uuid)
    this.idle(turn)
    const cancel = new AbortController()
    void turn.interrupted.then(() => {
      cancel.abort()
    })
    let outcome: McpToolOutcome
    try {
      outcome = await this.tools.call(name, input, cancel.signal)
    } catch (error) {
      // Cancelled by the interrupt: the turn ends as an interrupted one, with the call rejected.
      if (turn.isInterrupted) return
      throw error
    }
    if (!turn.isInterrupted) this.toolResult(turn, step.id, outcome.output, outcome.isError)
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
      permissionMode: sdkPermissionMode(this.permissionMode),
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

  private assistant(turn: TurnState, block: Record<string, unknown>, parent: string | null, uuid: string | null): void {
    if (turn.afterResult) {
      turn.messageId += 1
      turn.afterResult = false
    }
    const extra = block.type === 'tool_use' ? { tool_use_meta: [{ id: block.id, display_name: block.name }] } : {}
    this.push({
      type: 'assistant',
      parent_tool_use_id: parent,
      uuid: randomUUID(),
      // A turn the agent started on its own answers no message.
      ...(uuid === null ? {} : { user_message_uuid: uuid }),
      message: {
        id: `msg_${this.idPrefix}_${turn.key}_${String(turn.messageId)}`,
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
    return `toolu_${this.idPrefix}_${turn.key}_${id}`
  }

  private toolUse(
    turn: TurnState,
    id: string,
    name: string,
    input: ToolInput,
    parent: string | null,
    uuid: string | null,
  ): void {
    const sdkId = this.sdkToolId(turn, id)
    const sdkParent = parent === null ? null : this.sdkToolId(turn, parent)
    turn.running.set(id, { sdkId, parent: sdkParent, name, input })
    this.assistant(turn, { type: 'tool_use', id: sdkId, name, input }, sdkParent, uuid)
    if (SUBAGENT_TOOLS.has(name)) this.startForeground(sdkId, input)
    if (startsWatch(name, input)) this.startWatch(sdkId, input)
  }

  /**
   * A `Monitor` call, or a `Bash` call with `run_in_background`, starts its command as a task in the background, as the
   * SDK does (`docs/sdk-notes.md` §13): its `task_started`, backgrounded, of type `local_bash`.
   */
  private startWatch(toolUseId: string, input: ToolInput): void {
    this.scheduled += 1
    const taskId = `b${this.idPrefix}w${String(this.scheduled)}`
    const description = typeof input.description === 'string' ? input.description : ''
    this.watches.set(toolUseId, { taskId, toolUseId, description, running: true })
    this.push({
      type: 'system',
      subtype: 'task_started',
      task_id: taskId,
      tool_use_id: toolUseId,
      description,
      is_backgrounded: true,
      task_type: 'local_bash',
      uuid: randomUUID(),
    })
  }

  /**
   * What the SDK says of a call's result beside its text (`tool_use_result`), for the tools that start or schedule
   * something (`docs/sdk-notes.md` §13), which also keeps the job a `ScheduleWakeup` or `CronCreate` schedules, and
   * drops the one a `CronDelete` deletes. Undefined for any other tool, and a failed call.
   */
  private toolDetails(call: RunningCall, isError: boolean): Record<string, unknown> | undefined {
    if (isError) return undefined
    const { input, sdkId } = call
    const watch = this.watches.get(sdkId)
    switch (call.name) {
      case 'Monitor': {
        const timeoutMs = typeof input.timeout_ms === 'number' ? input.timeout_ms : DEFAULT_MONITOR_TIMEOUT_MS
        return { taskId: watch?.taskId ?? '', timeoutMs, persistent: false }
      }
      case 'Bash':
        return watch === undefined
          ? undefined
          : { stdout: '', stderr: '', interrupted: false, noOutputExpected: false, backgroundTaskId: watch.taskId }
      case 'ScheduleWakeup':
        return this.scheduleWakeup(sdkId, input)
      case 'CronCreate':
        return this.createCron(sdkId, input)
      case 'CronDelete': {
        const id = typeof input.id === 'string' ? input.id : ''
        const index = this.jobs.findIndex((job) => job.id === id)
        if (index >= 0) this.jobs.splice(index, 1)
        return { id }
      }
      default:
        return undefined
    }
  }

  /** A `ScheduleWakeup`: a one-off job at the whole minute after its (clamped) delay, or, with `stop`, none left. */
  private scheduleWakeup(toolUseId: string, input: ToolInput): Record<string, unknown> {
    if (input.stop === true) {
      const kept = this.jobs.filter((job) => !job.wakeup)
      const cancelledWakeups = this.jobs.length - kept.length
      this.jobs.splice(0, this.jobs.length, ...kept)
      return { scheduledFor: 0, clampedDelaySeconds: 0, wasClamped: false, stopped: true, cancelledWakeups }
    }
    const asked = typeof input.delaySeconds === 'number' ? input.delaySeconds : WAKEUP_MIN_DELAY_S
    const delay = Math.min(Math.max(asked, WAKEUP_MIN_DELAY_S), WAKEUP_MAX_DELAY_S)
    const scheduledFor = Math.ceil((Date.now() + delay * 1000) / MINUTE_MS) * MINUTE_MS
    const at = new Date(scheduledFor)
    this.scheduled += 1
    this.jobs.push({
      toolUseId,
      id: `${this.idPrefix.slice(0, 6)}w${String(this.scheduled)}`,
      schedule: `${String(at.getMinutes())} ${String(at.getHours())} * * *`,
      recurring: false,
      prompt: typeof input.prompt === 'string' ? input.prompt : '',
      wakeup: true,
    })
    return { scheduledFor, clampedDelaySeconds: delay, wasClamped: delay !== asked }
  }

  /** A `CronCreate`: a job on its schedule, recurring unless it says not. */
  private createCron(toolUseId: string, input: ToolInput): Record<string, unknown> {
    this.scheduled += 1
    const id = `${this.idPrefix.slice(0, 6)}c${String(this.scheduled)}`
    const schedule = typeof input.cron === 'string' ? input.cron : ''
    const recurring = input.recurring !== false
    const prompt = typeof input.prompt === 'string' ? input.prompt : ''
    this.jobs.push({ toolUseId, id, schedule, recurring, prompt, wakeup: false })
    return { id, humanSchedule: schedule, recurring, durable: false }
  }

  /**
   * A subagent the turn waits on starts as a task, as the SDK starts one (`docs/sdk-notes.md`, "Subagents"): its
   * `task_started`, not backgrounded.
   */
  private startForeground(agentId: string, input: ToolInput): void {
    this.backgrounds += 1
    const taskId = `a${this.idPrefix}${String(this.backgrounds)}`
    this.foreground.set(agentId, taskId)
    this.push({
      type: 'system',
      subtype: 'task_started',
      task_id: taskId,
      tool_use_id: agentId,
      description: typeof input.description === 'string' ? input.description : '',
      subagent_type: input.subagent_type ?? 'general-purpose',
      is_backgrounded: false,
      spawn_depth: 1,
      task_type: 'local_agent',
      prompt: input.prompt,
      uuid: randomUUID(),
    })
  }

  private toolResult(
    turn: TurnState,
    id: string,
    output: string,
    isError: boolean,
    details?: Readonly<Record<string, unknown>>,
  ): void {
    const call = turn.running.get(id)
    turn.running.delete(id)
    const taskId = call === undefined ? undefined : this.foreground.get(call.sdkId)
    // A subagent the turn waited on ends before its call's result, as the SDK ends one.
    if (call !== undefined && taskId !== undefined) {
      this.foreground.delete(call.sdkId)
      const status = isError ? 'failed' : 'completed'
      this.push({
        type: 'system',
        subtype: 'task_updated',
        task_id: taskId,
        patch: { status, end_time: Date.now() },
        uuid: randomUUID(),
      })
      this.push({
        type: 'system',
        subtype: 'task_notification',
        task_id: taskId,
        tool_use_id: call.sdkId,
        status,
        output_file: `tasks/${taskId}.output`,
        summary: output,
        uuid: randomUUID(),
      })
    }
    const made = call === undefined ? undefined : this.toolDetails(call, isError)
    const merged = made === undefined && details === undefined ? undefined : { ...made, ...details }
    this.pushToolResult(call?.sdkId ?? this.sdkToolId(turn, id), call?.parent ?? null, output, isError, merged)
    turn.afterResult = true
  }

  private pushToolResult(
    sdkId: string,
    parent: string | null,
    output: string,
    isError: boolean,
    details?: Readonly<Record<string, unknown>>,
  ): void {
    this.push({
      type: 'user',
      parent_tool_use_id: parent,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: sdkId, content: output, is_error: isError }],
      },
      tool_use_result: details ?? { stdout: isError ? '' : output, stderr: isError ? output : '', interrupted: false },
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
      // A turn the agent started on its own says so, and lists only the messages folded into it, if any.
      ...(turn.notified ? { origin: { kind: 'task-notification' } } : {}),
      ...(turn.woken && uuids.length === 0 ? {} : { user_message_uuids: uuids }),
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
