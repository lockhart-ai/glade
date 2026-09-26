/**
 * Agent scripts: what the test modes' fake agent does, turn by turn, in place of a model. A script is plain typed data,
 * named, with a list of turns; each user message runs the next turn (a message past the last turn runs the last turn
 * again). A turn is a list of steps, which `./scripted-session` plays into realistic SDK messages (shapes from
 * `docs/sdk-notes.md` §2), so the app handles them exactly as it would a real run.
 *
 * The e2e and capture specs pick a script from `AGENT_SCRIPTS` by name, e.g. `agentScript: 'multi-tool-turn'`.
 */
import {
  PermissionDestination,
  PermissionRuleBehavior,
  PermissionUpdateType,
  QuestionKind,
  type PermissionSuggestion,
  type Question,
  type ToolInput,
} from '../../shared/domain'

export enum ScriptStepKind {
  /** `system/init` for the session, which the SDK sends at the start of every turn. */
  Init = 'init',
  /** An assistant text block: preamble before a tool call, or the final reply. */
  Text = 'text',
  /** An assistant `tool_use` block. Its `id` is the script's own; the session makes it unique. */
  ToolUse = 'tool_use',
  /** The user `tool_result` for an earlier `ToolUse`, by the same `id` (and inside the same subagent, if any). */
  ToolResult = 'tool_result',
  /**
   * A call to one of Glade's own tools (`mcp__glade__<tool>`): the `tool_use`, then the tool's registered handler run
   * the way the SDK runs it, then its `tool_result`. So the call really updates the task.
   */
  GladeTool = 'glade_tool',
  /** The turn's `result`. Its text is the turn's last top-level text unless given; its duration is measured. */
  Result = 'result',
  /** Any SDK message, as is: for the ones the steps above don't cover. */
  Emit = 'emit',
  /** Waits, as a model thinking or a tool running would. An interrupt cuts it short. */
  Delay = 'delay',
  /** The agent process dies: the session's message stream throws `message`, and the session is over. */
  Fail = 'fail',
  /** Waits until the turn is interrupted (Stop), however long that takes. */
  WaitForInterrupt = 'wait_for_interrupt',
  /**
   * Fills the context: every assistant message from here on reports using `fraction` of the session model's window,
   * as a long session's would.
   */
  FillContext = 'fill_context',
  /**
   * Compacts the context, as `/compact` or the SDK's auto-compaction does (`docs/sdk-notes.md`, Compaction): the
   * compacting status, a `compact_boundary` from the context used so far to `postTokens`, and the summary the session
   * continues from. Assistant messages report `postTokens` from here on.
   */
  Compact = 'compact',
  /**
   * A call to Glade's `ask` (`mcp__glade__ask`), run through its real handler like a `GladeTool` step, so the questions
   * really open: the turn waits on the answers (the session goes idle meanwhile), then streams the tool's result, the
   * answers as JSON, and plays on. Stop withdraws the questions and cuts the call short.
   */
  Ask = 'ask',
  /**
   * The account's usage limit runs out: a `rate_limit_event` saying it's rejecting requests until `resetInMs` from now
   * (to the second, as the SDK gives it), as the SDK sends when a request hits the limit.
   */
  LimitReached = 'limit_reached',
  /**
   * The account is close to a usage limit: a `rate_limit_event` saying requests are allowed with a warning, with
   * `utilization` of the `window` used and the window resetting `resetInMs` from now (to the second, as the SDK gives
   * it), as the SDK sends at the start of each turn while the account is close.
   */
  LimitWarning = 'limit_warning',
  /**
   * The agent starts a turn of its own once the turn it's in has ended, as the SDK does when a background command or
   * subagent finishes, a `Monitor` reports an event, or a scheduled wakeup or cron job fires (`docs/sdk-notes.md`,
   * "Turns the agent starts itself" and §11): `ms` after this step (no time by default), and once no turn is playing,
   * the session streams what the SDK streams for its `cause` (see `WakeCause`), then plays `turn` with no user message
   * behind it. Its assistant messages carry no `user_message_uuid`, and its `result` no `user_message_uuids`. A message
   * sent while it plays is folded into it, as into any turn.
   */
  Wake = 'wake',
  /**
   * A background task (a `Monitor`'s, or a `Bash` call's with `run_in_background`) ends without waking the agent: its
   * `task_updated` and `task_notification`, carrying `summary`. That's how a subagent's ends (`docs/sdk-notes.md`,
   * "Background work inside a subagent"): the SDK wakes the subagent, not the agent. A task that was stopped meanwhile
   * streams nothing.
   */
  TaskEnd = 'task_end',
  /**
   * An `Agent` call that starts a subagent in the background (`run_in_background`), as the SDK does (`docs/sdk-notes.md`,
   * "Background subagents"): the `tool_use`, the subagent's `task_started` (`is_backgrounded: true`), and at once the
   * call's "launched" result, so the turn plays on and can end while the subagent works. The subagent then plays its
   * `steps` on its own, alongside whatever turns play, with a `task_progress` after each of its tool calls. When they're
   * done, it ends with `outcome`: a `task_updated` and a `task_notification` carrying `summary`, then, given a `turn`,
   * a turn the agent starts on its own, as for a `Wake`. Stop subagent (`stopTask`) cuts it short: it ends `stopped`,
   * with the interrupt marker the SDK sends, then plays `stoppedTurn`, if any.
   */
  Background = 'background',
  /**
   * A tool call that asks permission before it runs, as Claude Code asks `canUseTool` outside Allow all
   * (`docs/sdk-notes.md` §9): the `tool_use`, then, in the ask mode, the session asks the runner (its
   * `onToolPermission`) and waits for the answer, however long it takes (going idle meanwhile). Allowed, the call's
   * result is `output`; denied, it's an error carrying the denial's message, as the SDK gives it, and the turn plays on.
   * In Allow all it runs without asking, as the SDK bypasses the check. Stop cuts the wait short.
   */
  Permission = 'permission',
  /**
   * A call to one of Glade's control tools (`mcp__glade-control__<tool>`, `docs/control-api.md`), which the session
   * has while agents may control Glade: the `tool_use`, then, in the ask mode, the session asks the runner about it as
   * Claude Code asks about any MCP tool not in its allowed tools (the runner lets the reads through without a card),
   * then, allowed, the tool's registered handler runs the way the SDK runs it, and its `tool_result` follows. So the
   * call really changes Glade. Denied, its result is the denial, as for a `Permission` step.
   */
  ControlTool = 'control_tool',
  /**
   * A subagent's progress summary, as the SDK sends one about every 30 seconds with `agentProgressSummaries` on
   * (`docs/sdk-notes.md`, "Subagents"): a `task_progress` for the subagent its `Agent` call `id` started (in the
   * foreground or the background), carrying `summary`. It's sent whether or not the subagent is still running, as a late
   * one can be.
   */
  Progress = 'progress',
  /**
   * A `Bash` call that really runs its command, in the session's folder (or `cwd` from it), with `/bin/sh`, as Claude
   * Code runs one: the `tool_use`, then the session's `PreToolUse` hook (`hooks.onBashStarting`) with the call's folder
   * and command, which the call waits for, then the command, then its result: what it printed, an error if it exited
   * non-zero. Git in it reads no config of the machine's (`SHELL_GIT_ENV`), so a script's commits are the same
   * anywhere. For the Changes tab's scripts, whose agents make real commits (`docs/sdk-notes.md` §14).
   */
  Shell = 'shell',
}

export interface InitStep {
  readonly kind: ScriptStepKind.Init
}

export interface TextStep {
  readonly kind: ScriptStepKind.Text
  readonly text: string
  /** The `Agent` call's id when a subagent writes it. */
  readonly parent?: string
}

export interface ToolUseStep {
  readonly kind: ScriptStepKind.ToolUse
  readonly id: string
  readonly name: string
  readonly input: ToolInput
  /** The `Agent` call's id when a subagent makes the call. */
  readonly parent?: string
}

export interface ToolResultStep {
  readonly kind: ScriptStepKind.ToolResult
  readonly id: string
  readonly output: string
  readonly isError?: boolean
  /**
   * What the SDK says of the result beside its text (`tool_use_result`), over what the session makes for the call's
   * tool (see `ScriptedSession`): e.g. a `CronCreate` job's `humanSchedule`.
   */
  readonly details?: Readonly<Record<string, unknown>>
}

export interface GladeToolStep {
  readonly kind: ScriptStepKind.GladeTool
  readonly id: string
  /** The tool's name on the `glade` server, e.g. `set_title`. */
  readonly tool: string
  readonly input: ToolInput
}

export interface ResultStep {
  readonly kind: ScriptStepKind.Result
  /** The reply; the turn's last top-level text by default. */
  readonly text?: string
  readonly isError?: boolean
  /** `completed` by default. */
  readonly terminalReason?: string
  readonly errors?: readonly string[]
  /** Extra fields for the `result` message, e.g. `api_error_status`. */
  readonly extra?: Readonly<Record<string, unknown>>
}

export interface EmitStep {
  readonly kind: ScriptStepKind.Emit
  readonly message: unknown
}

export interface DelayStep {
  readonly kind: ScriptStepKind.Delay
  readonly ms: number
}

export interface FailStep {
  readonly kind: ScriptStepKind.Fail
  readonly message: string
}

export interface WaitForInterruptStep {
  readonly kind: ScriptStepKind.WaitForInterrupt
}

export interface FillContextStep {
  readonly kind: ScriptStepKind.FillContext
  /** How full the context is, from 0 to 1. */
  readonly fraction: number
}

export interface CompactStep {
  readonly kind: ScriptStepKind.Compact
  /** What's left after compacting, in tokens: a fifth of the context used by default. */
  readonly postTokens?: number
  /** `manual` by default. */
  readonly trigger?: 'manual' | 'auto'
  /** How long it compacts for, in milliseconds, between the compacting status and the boundary: no time by default. */
  readonly ms?: number
}

export interface AskStep {
  readonly kind: ScriptStepKind.Ask
  readonly id: string
  /** What the agent says before its questions, at the top of the card; none unless given. */
  readonly preamble?: string | undefined
  readonly questions: readonly Question[]
}

export interface LimitReachedStep {
  readonly kind: ScriptStepKind.LimitReached
  /** How long from now the limit resets. */
  readonly resetInMs: number
}

export interface LimitWarningStep {
  readonly kind: ScriptStepKind.LimitWarning
  /** How much of the window is used, from 0 to 1. */
  readonly utilization: number
  /** The window, as the SDK names it (`rateLimitType`), e.g. `five_hour`. */
  readonly window: string
  /** How long from now the window resets. */
  readonly resetInMs: number
}

/**
 * What wakes the agent in a `Wake` step, and so what the SDK streams before the turn, what its prompt hook is told
 * (`SessionHooks.onPrompt`, `docs/sdk-notes.md` §13), and what the turn's `result` says.
 */
export enum WakeCause {
  /**
   * A background task (a command, or a `Monitor`'s watch) ended: its `task_updated` and `task_notification`, carrying
   * `summary`, come first; the prompt hook is told its ending's `<task-notification>`; and the turn's `result` says
   * `origin: task-notification`. A task that was stopped meanwhile never wakes it.
   */
  TaskEnded = 'task_ended',
  /**
   * A `Monitor` printed an event: nothing comes first, the prompt hook is told the event's `<task-notification>`, and
   * the turn's `result` says `origin: task-notification`. A watch that was stopped meanwhile never wakes it.
   */
  MonitorEvent = 'monitor_event',
  /**
   * A `ScheduleWakeup` or `CronCreate` job fired: its `command_lifecycle` comes first, the prompt hook is told its
   * prompt, and the turn's `result` has no `origin`. A job the agent deleted never fires; one the hook turns away runs
   * no turn (the SDK's informational message and a bare `result` instead).
   */
  Scheduled = 'scheduled',
}

export interface WakeStep {
  readonly kind: ScriptStepKind.Wake
  /** `TaskEnded` by default. */
  readonly cause?: WakeCause
  /** How long after this step the agent wakes, in milliseconds: no time by default. */
  readonly ms?: number
  /**
   * The script id of the tool call, in this turn, whose background task (a `Monitor`, or a `Bash` with
   * `run_in_background`) finished or printed the event; none for a timer or wakeup.
   */
  readonly task?: string
  /** What the task notification says finished, for a `TaskEnded` wake; the others stream no notification. */
  readonly summary?: string
  /** How the task ended, for a `TaskEnded` wake: `completed` by default. */
  readonly outcome?: BackgroundOutcome
  /** The lines a `Monitor` printed, for a `MonitorEvent` wake (or with its ending, for a `TaskEnded` one). */
  readonly event?: string
  /** The script id of the `ScheduleWakeup` or `CronCreate` call, in this turn, whose job fired, for a `Scheduled` wake. */
  readonly job?: string
  /** What the agent does in the turn it starts. */
  readonly turn: ScriptTurn
}

export interface TaskEndStep {
  readonly kind: ScriptStepKind.TaskEnd
  /** The script id of the `Monitor` or `Bash` call, in this turn or subagent, whose task ends. */
  readonly task: string
  /** What its notification says. */
  readonly summary: string
  /** `completed` by default. */
  readonly outcome?: BackgroundOutcome
}

/** How a background subagent ends when it plays all its steps (the SDK's `task_notification.status`). */
export type BackgroundOutcome = 'completed' | 'failed'

export interface BackgroundStep {
  readonly kind: ScriptStepKind.Background
  /** The `Agent` call's script id: the subagent's steps name it as their `parent`. */
  readonly id: string
  /** The `Agent` call's input (`description`, `prompt`, `subagent_type`); `run_in_background: true` is added. */
  readonly input: ToolInput
  /** What the subagent does: its text, tool calls and results (each with `parent: id`) and delays. */
  readonly steps: ScriptTurn
  /** `completed` by default. */
  readonly outcome?: BackgroundOutcome
  /** What the task notification says it came to: its final reply, or what failed. */
  readonly summary: string
  /** What the agent does in the turn it starts once the subagent has ended; none by default. */
  readonly turn?: ScriptTurn
  /** What the agent does in the turn it starts once the subagent is stopped; none by default. */
  readonly stoppedTurn?: ScriptTurn
}

export interface PermissionStep {
  readonly kind: ScriptStepKind.Permission
  readonly id: string
  readonly name: string
  readonly input: ToolInput
  /** The call's result when it's allowed. */
  readonly output: string
  /** The `Agent` call's id when a subagent makes the call. */
  readonly parent?: string
  /** The SDK's id for that subagent (`agentID`); a made-up one when there's a `parent` and this is left out. */
  readonly agentId?: string
  /** What the SDK suggests would stop the call asking again; none by default. */
  readonly suggestions?: readonly PermissionSuggestion[]
  /** Claude Code's subtitle for the call; none by default. */
  readonly description?: string
  /** Claude Code's prompt sentence for the call, e.g. "Claude wants to edit a.txt"; none by default. */
  readonly title?: string
  /** Whether the prompt mustn't be approvable by a stray key; false by default. */
  readonly defaultToNo?: boolean
}

export interface ControlToolStep {
  readonly kind: ScriptStepKind.ControlTool
  readonly id: string
  /** The tool's name on the `glade-control` server, e.g. `create_task`. */
  readonly tool: string
  /** Its input, or what makes it from the session's folder (its `cwd`), for one that names files there. */
  readonly input: ToolInput | ((cwd: string) => ToolInput)
}

export interface ProgressStep {
  readonly kind: ScriptStepKind.Progress
  /** The script id of the `Agent` call that started the subagent. */
  readonly id: string
  /** What it's doing now, on one line. */
  readonly summary: string
}

export interface ShellStep {
  readonly kind: ScriptStepKind.Shell
  readonly id: string
  readonly command: string
  /** What the call says it does. */
  readonly description: string
  /** The folder it runs in, from the session's; the session's by default. */
  readonly cwd?: string
  /** The `Agent` call's id when a subagent makes the call. */
  readonly parent?: string
}

export type ScriptStep =
  | ShellStep
  | InitStep
  | TextStep
  | ToolUseStep
  | ToolResultStep
  | GladeToolStep
  | ResultStep
  | EmitStep
  | DelayStep
  | FailStep
  | WaitForInterruptStep
  | FillContextStep
  | CompactStep
  | AskStep
  | LimitReachedStep
  | LimitWarningStep
  | WakeStep
  | TaskEndStep
  | BackgroundStep
  | PermissionStep
  | ControlToolStep
  | ProgressStep

export type ScriptTurn = readonly ScriptStep[]

export interface AgentScript {
  readonly name: string
  /** At least one. */
  readonly turns: readonly ScriptTurn[]
  /**
   * What the agent does when Glade resumes its session to carry on a turn the app quit in: on launch (the runner's
   * `RESUME_PROMPT`), or once you answer a question or the permission requests the app quit on (its
   * `answeredAfterRestart` and `permissionsDecidedAfterRestart` messages). Without one,
   * that message runs the next turn like any other.
   */
  readonly resumeTurn?: ScriptTurn
  /**
   * What the agent does when Glade sends it `/compact` (the runner's `COMPACT_COMMAND`). By default it compacts, as
   * `DEFAULT_COMPACT_TURN` does. It isn't one of `turns`: the message after it runs the next of those.
   */
  readonly compactTurn?: ScriptTurn
  /**
   * The cron jobs the SDK brings back from the session's transcript when it's resumed (`docs/sdk-notes.md` §11): a
   * resumed session starts with these, as scheduled jobs its `Stop` hook lists. None by default.
   */
  readonly restoredJobs?: readonly RestoredJob[]
}

/** A cron job a resumed session has from before (`AgentScript.restoredJobs`), as its `Stop` hook lists it. */
export interface RestoredJob {
  readonly id: string
  readonly schedule: string
  readonly recurring: boolean
  readonly prompt: string
}

// Step builders, so scripts read as a turn would.

export const init = (): InitStep => ({ kind: ScriptStepKind.Init })

export const say = (text: string, parent?: string): TextStep => ({
  kind: ScriptStepKind.Text,
  text,
  ...(parent === undefined ? {} : { parent }),
})

export const toolUse = (id: string, name: string, input: ToolInput, parent?: string): ToolUseStep => ({
  kind: ScriptStepKind.ToolUse,
  id,
  name,
  input,
  ...(parent === undefined ? {} : { parent }),
})

export const toolResult = (
  id: string,
  output: string,
  isError = false,
  details?: Readonly<Record<string, unknown>>,
): ToolResultStep => ({
  kind: ScriptStepKind.ToolResult,
  id,
  output,
  isError,
  ...(details === undefined ? {} : { details }),
})

/** A tool call and its result, back to back. */
export const tool = (
  id: string,
  name: string,
  input: ToolInput,
  output: string,
  parent?: string,
): readonly [ToolUseStep, ToolResultStep] => [toolUse(id, name, input, parent), toolResult(id, output)]

export const gladeTool = (id: string, name: string, input: ToolInput): GladeToolStep => ({
  kind: ScriptStepKind.GladeTool,
  id,
  tool: name,
  input,
})

export const controlTool = (
  id: string,
  name: string,
  input: ToolInput | ((cwd: string) => ToolInput),
): ControlToolStep => ({
  kind: ScriptStepKind.ControlTool,
  id,
  tool: name,
  input,
})

export const result = (options: Omit<ResultStep, 'kind'> = {}): ResultStep => ({
  kind: ScriptStepKind.Result,
  ...options,
})

export const shell = (
  id: string,
  command: string,
  description: string,
  options: Pick<ShellStep, 'cwd' | 'parent'> = {},
): ShellStep => ({ kind: ScriptStepKind.Shell, id, command, description, ...options })

export const emit = (message: unknown): EmitStep => ({ kind: ScriptStepKind.Emit, message })

export const delay = (ms: number): DelayStep => ({ kind: ScriptStepKind.Delay, ms })

export const fail = (message: string): FailStep => ({ kind: ScriptStepKind.Fail, message })

export const waitForInterrupt = (): WaitForInterruptStep => ({ kind: ScriptStepKind.WaitForInterrupt })

export const fillContext = (fraction: number): FillContextStep => ({ kind: ScriptStepKind.FillContext, fraction })

export const compact = (options: Omit<CompactStep, 'kind'> = {}): CompactStep => ({
  kind: ScriptStepKind.Compact,
  ...options,
})

export const ask = (id: string, questions: readonly Question[], preamble?: string): AskStep => ({
  kind: ScriptStepKind.Ask,
  id,
  questions,
  ...(preamble === undefined ? {} : { preamble }),
})

export const limitReached = (resetInMs: number): LimitReachedStep => ({
  kind: ScriptStepKind.LimitReached,
  resetInMs,
})

export const limitWarning = (utilization: number, window: string, resetInMs: number): LimitWarningStep => ({
  kind: ScriptStepKind.LimitWarning,
  utilization,
  window,
  resetInMs,
})

export const wake = (turn: ScriptTurn, options: Omit<WakeStep, 'kind' | 'turn'>): WakeStep => ({
  kind: ScriptStepKind.Wake,
  turn,
  ...options,
})

export const taskEnd = (task: string, summary: string, outcome?: BackgroundOutcome): TaskEndStep => ({
  kind: ScriptStepKind.TaskEnd,
  task,
  summary,
  ...(outcome === undefined ? {} : { outcome }),
})

export const background = (
  id: string,
  input: ToolInput,
  steps: ScriptTurn,
  options: Omit<BackgroundStep, 'kind' | 'id' | 'input' | 'steps'>,
): BackgroundStep => ({ kind: ScriptStepKind.Background, id, input, steps, ...options })

export const progress = (id: string, summary: string): ProgressStep => ({ kind: ScriptStepKind.Progress, id, summary })

export const permission = (
  id: string,
  name: string,
  input: ToolInput,
  output: string,
  options: Omit<PermissionStep, 'kind' | 'id' | 'name' | 'input' | 'output'> = {},
): PermissionStep => ({ kind: ScriptStepKind.Permission, id, name, input, output, ...options })

/** What Claude Code suggests for a `Bash` call that asks: an exact rule for the command (as probed, §9). */
export const bashSuggestions = (command: string): readonly PermissionSuggestion[] => [
  {
    type: PermissionUpdateType.AddRules,
    rules: [{ toolName: 'Bash', ruleContent: command }],
    behavior: PermissionRuleBehavior.Allow,
    destination: PermissionDestination.LocalSettings,
  },
  { type: PermissionUpdateType.SetMode, mode: 'acceptEdits', destination: PermissionDestination.Session },
]

/** What Claude Code suggests for a `Bash` call whose command it takes a prefix of: a prefix rule (as probed, §9). */
export const bashPrefixSuggestions = (prefix: string): readonly PermissionSuggestion[] => [
  {
    type: PermissionUpdateType.AddRules,
    rules: [{ toolName: 'Bash', ruleContent: `${prefix} *` }],
    behavior: PermissionRuleBehavior.Allow,
    destination: PermissionDestination.LocalSettings,
  },
]

/** How long a step "takes" in the library's scripts: long enough to see in a recording, short enough for a test. */
const BEAT_MS = 150

/** What a turn starts with: init, and the messages the SDK sends before the model answers, which Glade ignores. */
const turnStart = (): ScriptStep[] => [
  init(),
  emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }),
  emit({ type: 'system', subtype: 'status', status: 'requesting' }),
]

/** The Glade tool calls a first turn makes: the agent names the task, sets its objective and keeps its status current. */
const describeTask = (title: string, objective: string, status: string): ScriptStep[] => [
  gladeTool('title', 'set_title', { title }),
  gladeTool('objective', 'set_objective', { objective }),
  gladeTool('status', 'set_status', { status }),
]

/** A question answered in one go: no tools but Glade's own. */
const simpleReply: AgentScript = {
  name: 'simple-reply',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      ...describeTask(
        'Explain the retry policy',
        'Explain how the API client retries failed requests.',
        'Answered the question about retries.',
      ),
      say(
        'The client retries idempotent requests up to 3 times, with exponential backoff starting at 200 ms. ' +
          'Non-idempotent requests are never retried.',
      ),
      result(),
    ],
  ],
}

/** A turn with a preamble, a subagent, and file, search, edit and shell tools, then a final reply. */
const multiToolTurn: AgentScript = {
  name: 'multi-tool-turn',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      say("I'll find where the date is formatted, then fix the timezone bug and run the tests."),
      ...describeTask(
        'Fix the flaky date test',
        'Make the date formatting test pass in every timezone.',
        'Looking for the date formatting code.',
      ),
      ...tool(
        'read',
        'Read',
        { file_path: 'src/date.ts' },
        'export function formatDate(d: Date) {\n  return d.toISOString().slice(0, 10)\n}',
      ),
      delay(BEAT_MS),
      ...tool('grep', 'Grep', { pattern: 'formatDate', path: 'src' }, 'src/date.ts\nsrc/report.ts\ntest/date.test.ts'),
      toolUse('explore', 'Agent', {
        description: 'Find flaky tests',
        prompt: 'Find the tests that depend on the local timezone.',
        subagent_type: 'Explore',
      }),
      ...tool('explore-grep', 'Grep', { pattern: 'new Date\\(', path: 'test' }, 'test/date.test.ts', 'explore'),
      ...tool('explore-read', 'Read', { file_path: 'test/date.test.ts' }, "it('formats', () => { … })", 'explore'),
      toolResult('explore', 'test/date.test.ts builds its dates in local time.'),
      delay(BEAT_MS),
      ...tool(
        'edit',
        'Edit',
        {
          file_path: 'src/date.ts',
          old_string: 'd.toISOString().slice(0, 10)',
          new_string: "d.toLocaleDateString('en-CA', { timeZone: 'UTC' })",
        },
        'The file src/date.ts has been updated.',
      ),
      gladeTool('status-tests', 'set_status', { status: 'Running the tests.' }),
      toolUse('test', 'Bash', { command: 'npm test', description: 'Run the test suite' }),
      delay(BEAT_MS),
      toolResult('test', 'Test Files  12 passed (12)\n     Tests  148 passed (148)'),
      gladeTool('status-done', 'set_status', { status: 'Fixed the timezone bug; the tests pass.' }),
      say(
        'The failing test was a timezone bug: `formatDate` used the local date. It now formats in UTC, and all 148 tests pass.',
      ),
      result(),
    ],
    // A follow-up, e.g. the message that reopens the task once it's done.
    [
      ...turnStart(),
      delay(BEAT_MS),
      say('Reopened. Checking the report header, which formats dates too.'),
      gladeTool('status-reopened', 'set_status', { status: 'Reopened to fix the report header date too.' }),
      ...tool(
        'report',
        'Read',
        { file_path: 'src/report.ts' },
        'export const header = (d: Date) => `Report for ${formatDate(d)}`',
      ),
      delay(BEAT_MS),
      gladeTool('status-reopened-done', 'set_status', { status: 'The report header uses the UTC date too.' }),
      say('The report header already goes through `formatDate`, so it uses the UTC date too. Nothing else to change.'),
      result(),
    ],
  ],
}

/**
 * A turn that keeps working, with a command still running, until it's stopped; then a short reply to the message sent
 * after the stop, so a spec can see the stopped task carry on. If the app quits mid-turn instead, the resumed session
 * runs the suite again and finishes the turn.
 */
const longRunning: AgentScript = {
  name: 'long-running',
  turns: [
    [
      ...turnStart(),
      say("I'll run the full end-to-end suite; it takes a while."),
      ...describeTask('Run the e2e suite', 'Run the end-to-end suite and fix what fails.', 'Running the e2e suite.'),
      toolUse('suite', 'Bash', { command: 'npm run test:e2e', description: 'Run the end-to-end suite' }),
      waitForInterrupt(),
    ],
    [
      ...turnStart(),
      delay(BEAT_MS),
      say('Understood. I stopped the suite and will only run the unit tests.'),
      result(),
    ],
  ],
  resumeTurn: [
    ...turnStart(),
    say('Glade restarted mid-run, so I am running the suite again.'),
    ...tool(
      'suite-again',
      'Bash',
      { command: 'npm run test:e2e', description: 'Run the end-to-end suite' },
      '41 passed (41)',
    ),
    delay(BEAT_MS),
    gladeTool('status-resumed', 'set_status', { status: 'The e2e suite passes.' }),
    say('The end-to-end suite passes: all 41 tests.'),
    result(),
  ],
}

/**
 * A release build that keeps going, with its command running, until it's stopped or the app quits, like `long-running`,
 * so a spec can run several long turns side by side. Resumed after a quit, it builds again and finishes the turn.
 */
const longBuild: AgentScript = {
  name: 'long-build',
  turns: [
    [
      ...turnStart(),
      say("I'll build the release; it takes a few minutes."),
      ...describeTask('Build the release', 'Build the 0.3.0 release for macOS.', 'Building the release.'),
      toolUse('build', 'Bash', { command: 'npm run dist', description: 'Build the release' }),
      waitForInterrupt(),
    ],
  ],
  resumeTurn: [
    ...turnStart(),
    say('Glade restarted mid-build, so I am building the release again.'),
    ...tool(
      'build-again',
      'Bash',
      { command: 'npm run dist', description: 'Build the release' },
      'dist/glade-0.3.0.dmg',
    ),
    delay(BEAT_MS),
    gladeTool('status-built', 'set_status', { status: 'The release is built.' }),
    say('The release is built: dist/glade-0.3.0.dmg.'),
    result(),
  ],
}

/** What a script's agent does when sent `/compact`, unless the script says otherwise: compacts, and ends the turn. */
export const DEFAULT_COMPACT_TURN: ScriptTurn = [init(), delay(BEAT_MS), compact(), result({ text: '' })]

/**
 * A long session, for compaction: its turn leaves the context 95% full, near the auto-compact threshold. Compacting
 * leaves a fifth of it, and the next message is answered from there.
 */
const longContext: AgentScript = {
  name: 'long-context',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      ...describeTask(
        'Move image uploads to S3',
        'Move user image uploads from local disk to S3, and copy the existing files over.',
        'All files copied and spot-checked.',
      ),
      fillContext(0.95),
      say('All 3,900 files are copied and 50 random ones match byte for byte. Next I will update the stored paths.'),
      result(),
    ],
    [...turnStart(), delay(BEAT_MS), say('Updated the stored paths of all 3,900 files.'), result()],
  ],
  // Slower than the default, so a recording shows it compacting.
  compactTurn: [init(), delay(BEAT_MS * 4), compact(), result({ text: '' })],
}

/**
 * A long turn that crosses the SDK's auto-compact threshold (967k of the default model's 1M window) part way through:
 * the SDK compacts on its own, in the middle of the turn, and the turn carries on from the summary to its reply. Its
 * steps take their time, so a spec or a recording sees the meter past the threshold and the compaction running.
 */
const autoCompaction: AgentScript = {
  name: 'auto-compaction',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      say("I'll copy the existing uploads to the bucket, check a sample, then update the stored paths."),
      ...describeTask(
        'Move image uploads to S3',
        'Move user image uploads from local disk to S3, and copy the existing files over.',
        'Copying the existing files.',
      ),
      fillContext(0.6),
      ...tool(
        'copy',
        'Bash',
        { command: 'python scripts/copy_media_to_s3.py', description: 'Copy the existing uploads to S3' },
        'copied 3,900 of 3,900',
      ),
      delay(BEAT_MS),
      fillContext(0.97),
      ...tool(
        'sample',
        'Bash',
        { command: 'python scripts/check_media_sample.py --count 50', description: 'Check a sample against the disk' },
        '50 of 50 match',
      ),
      delay(BEAT_MS * 4),
      compact({ trigger: 'auto', postTokens: 41_000, ms: BEAT_MS * 4 }),
      gladeTool('status-paths', 'set_status', { status: 'All files copied and spot-checked. Updating stored paths.' }),
      ...tool(
        'paths',
        'Bash',
        { command: 'python manage.py update_media_paths', description: 'Update the stored paths' },
        'Updated 3,900 paths.',
      ),
      delay(BEAT_MS),
      say('All 3,900 files are copied, 50 random ones match byte for byte, and the stored paths point at the bucket.'),
      result(),
    ],
  ],
}

/** What the API says when it's overloaded, as the SDK words it. */
const OVERLOADED_ERROR =
  'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011Sample"}'

/** The notice the SDK sends before it retries an overloaded API request (`docs/sdk-notes.md`, "Errors and retries"). */
const overloadedRetry = (attempt: number, maxRetries: number, delayMs = BEAT_MS): EmitStep =>
  emit({
    type: 'system',
    subtype: 'api_retry',
    attempt,
    max_retries: maxRetries,
    retry_delay_ms: delayMs,
    error_status: 529,
    error: 'overloaded',
  })

/**
 * How long each retry of an overloaded request waits in `flaky-api`: long enough for a spec polling the working line to
 * see "Retrying (n of 3)…", which three short beats could slip past.
 */
const RETRY_WAIT_MS = 1000

/**
 * An overloaded API, as Claude Code handles it: it retries the request `retries` times, `waitMs` apart, then gives up,
 * and the turn ends on the API error.
 */
const overloaded = (retries: number, waitMs = BEAT_MS): ScriptStep[] => [
  ...Array.from({ length: retries }, (_, index) => [overloadedRetry(index + 1, retries, waitMs), delay(waitMs)]).flat(),
  emit({
    type: 'assistant',
    parent_tool_use_id: null,
    error: 'overloaded',
    message: { id: 'msg_api_error', role: 'assistant', content: [{ type: 'text', text: OVERLOADED_ERROR }] },
  }),
  result({
    text: OVERLOADED_ERROR,
    isError: true,
    terminalReason: 'api_error',
    extra: { api_error_status: 529 },
  }),
]

/** A turn that fails on an API error after it has started working, however often it's retried. */
const failingTurn: AgentScript = {
  name: 'failing-turn',
  turns: [
    [
      ...turnStart(),
      say("I'll check the build first."),
      ...tool('build', 'Bash', { command: 'npm run build', description: 'Build the app' }, 'Built in 2.1s'),
      delay(BEAT_MS),
      ...overloaded(3),
    ],
  ],
}

/** What the `fails-to-start` agent's Claude Code prints as it gives up. */
export const STARTUP_FAILURE_ERROR = 'Error: The working directory no longer exists. Open the workspace folder again.'

/**
 * A session Claude Code can't start, because the workspace folder is gone: it ends at once with the zeroed result that
 * names why (`startup_failure_reason`, as `CLAUDE_CODE_STARTUP_FAILURE_RESULTS` asks), and no `init`, then its process
 * exits. Every message fails the same way.
 */
const failsToStart: AgentScript = {
  name: 'fails-to-start',
  turns: [
    [
      result({
        isError: true,
        text: '',
        errors: [STARTUP_FAILURE_ERROR],
        extra: { subtype: 'error_during_execution', num_turns: 0, startup_failure_reason: 'cwd_unavailable' },
      }),
      fail('Claude Code process exited with code 1'),
    ],
  ],
}

/**
 * A turn that fails on an overloaded API after it has started working, and a retry of it that gets through: the API
 * is still overloaded at first, but the request goes through on the first retry this time, and the turn finishes.
 */
const flakyApi: AgentScript = {
  name: 'flaky-api',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      say("I'll reproduce the failure against Postgres first."),
      ...describeTask(
        'Fix flaky login test',
        'test_login_redirect fails about one run in ten on CI. Find out why and fix it, without just adding retries.',
        'Reproducing the failure against Postgres.',
      ),
      ...tool(
        'db',
        'Bash',
        { command: 'docker compose up -d db', description: 'Start Postgres' },
        'Container api-db-1  Started',
      ),
      delay(BEAT_MS),
      ...overloaded(3, RETRY_WAIT_MS),
    ],
    [
      ...turnStart(),
      overloadedRetry(1, 3),
      delay(BEAT_MS),
      say('Running the test 200 times against Postgres.'),
      ...tool(
        'repeat',
        'Bash',
        { command: 'pytest -x --count 200 tests/test_auth.py', description: 'Run the login test 200 times' },
        '200 passed in 41.2s',
      ),
      delay(BEAT_MS),
      gladeTool('status-fixed', 'set_status', {
        status: 'Fixed the race in the test; it passes 200 times on Postgres.',
      }),
      say('The test passes 200 times in a row against Postgres, so the race is fixed.'),
      result(),
    ],
  ],
}

/** What the API says when the account's usage limit has run out, as the SDK words it. */
const USAGE_LIMIT_ERROR = "You've hit your session limit · resets 11:42am"

/**
 * The account's usage limit runs out, as Claude Code reports it: the limit rejects requests until `resetInMs` from
 * now, and the turn ends on the API's 429. Claude Code doesn't retry it.
 */
const usageLimitReached = (resetInMs: number): ScriptStep[] => [limitReached(resetInMs), ...usageLimitError()]

/** The API's 429 for a spent usage limit, and the turn's error result: Claude Code doesn't retry it. */
const usageLimitError = (): ScriptStep[] => [
  emit({
    type: 'assistant',
    parent_tool_use_id: null,
    error: 'rate_limit',
    message: { id: 'msg_api_error', role: 'assistant', content: [{ type: 'text', text: USAGE_LIMIT_ERROR }] },
  }),
  result({ text: USAGE_LIMIT_ERROR, isError: true, terminalReason: 'api_error', extra: { api_error_status: 429 } }),
]

/** What the SDK says when it couldn't reach the API at all. */
const CONNECTION_ERROR = 'API Error: Connection error.'

/** The API can't be reached, as Claude Code reports it once its retries are spent: a connection error, no status. */
const connectionLost = (): ScriptStep[] => [
  emit({
    type: 'assistant',
    parent_tool_use_id: null,
    error: 'unknown',
    message: { id: 'msg_api_error', role: 'assistant', content: [{ type: 'text', text: CONNECTION_ERROR }] },
  }),
  result({ text: CONNECTION_ERROR, isError: true, terminalReason: 'api_error' }),
]

/** How soon the limit resets in `usage-limit`: soon enough for a spec to watch the tasks resume on their own. */
const SHORT_RESET_MS = 6000

/** How soon the limit resets in `usage-limit-hour`: long enough that nothing resumes during a spec on its own. */
const HOUR_RESET_MS = 60 * 60_000

/** The turn a usage-limit or offline script finishes with once it resumes: the copy completes. */
const copyCompletes = (): ScriptStep[] => [
  ...turnStart(),
  delay(BEAT_MS),
  say('Picking up where the copy stopped.'),
  ...tool(
    'copy-rest',
    'Bash',
    { command: 'python scripts/copy_media_to_s3.py --resume', description: 'Copy the rest of the uploads to S3' },
    'copied 3,900 of 3,900',
  ),
  delay(BEAT_MS),
  gladeTool('status-copied', 'set_status', { status: 'All 3,900 files copied to S3.' }),
  say('The copy finished: all 3,900 files are in the bucket.'),
  result(),
]

/** A copy that runs until something outside the task stops it, then `ending`. */
const copyUntil = (ending: readonly ScriptStep[]): ScriptStep[] => [
  ...turnStart(),
  delay(BEAT_MS),
  say("I'll copy the existing uploads to the bucket, then check a sample."),
  ...describeTask(
    'Move image uploads to S3',
    'Move user image uploads from local disk to S3, and copy the existing files over.',
    'Copying existing files: 1,240 of 3,900 done.',
  ),
  ...tool(
    'copy',
    'Bash',
    { command: 'python scripts/copy_media_to_s3.py', description: 'Copy the existing uploads to S3' },
    'copied 1,240 of 3,900',
  ),
  delay(BEAT_MS),
  ...ending,
]

/**
 * A copy that runs into the account's usage limit, which resets a few seconds later; the task resumes on its own then
 * (the retry is its second turn) and the copy completes.
 */
const usageLimit: AgentScript = {
  name: 'usage-limit',
  turns: [copyUntil(usageLimitReached(SHORT_RESET_MS)), copyCompletes()],
}

/** `usage-limit` with a limit that resets in an hour, so the task stays paused unless it's resumed some other way. */
const usageLimitHour: AgentScript = {
  name: 'usage-limit-hour',
  turns: [copyUntil(usageLimitReached(HOUR_RESET_MS)), copyCompletes()],
}

/** How much of its session limit the account has used in the usage-warning scripts. */
const WARNING_UTILIZATION = 0.85

/** A turn's start while the account is close to its session limit, which resets `resetInMs` from now. */
const warnedTurnStart = (utilization: number, resetInMs: number): ScriptStep[] => [
  init(),
  limitWarning(utilization, 'five_hour', resetInMs),
  emit({ type: 'system', subtype: 'status', status: 'requesting' }),
]

/** A short turn while the account is close to its session limit, which resets `resetInMs` from now. */
const warnedReply = (resetInMs: number): ScriptStep[] => [
  ...warnedTurnStart(WARNING_UTILIZATION, resetInMs),
  delay(BEAT_MS),
  ...describeTask(
    'Add rate limiting to public API',
    'Add per-key rate limiting to the public API so one client can’t starve the others.',
    'Throttle class written; applying it to the viewsets next.',
  ),
  say('The throttle class is written. Next I’ll apply it to the three public viewsets.'),
  result(),
]

/**
 * The account is close to its session limit, which resets in an hour: each turn starts with the SDK's warning, and goes
 * on as usual.
 */
const usageWarning: AgentScript = {
  name: 'usage-warning',
  turns: [warnedReply(HOUR_RESET_MS)],
}

/** `usage-warning` with a window that resets a few seconds later, so the warning goes on its own. */
const usageWarningResets: AgentScript = {
  name: 'usage-warning-resets',
  turns: [warnedReply(SHORT_RESET_MS)],
}

/**
 * Warned, then over the limit: the first turn warns and replies; the second starts with a closer warning, then runs
 * into the limit. The API's 429 ends it with no `rejected` event first, so the warning still stands when the task
 * pauses (to resume after Glade's fallback wait).
 */
const usageWarningThenLimit: AgentScript = {
  name: 'usage-warning-then-limit',
  turns: [
    warnedReply(HOUR_RESET_MS),
    [
      ...warnedTurnStart(0.97, HOUR_RESET_MS),
      delay(BEAT_MS),
      say('Applying the throttle to the viewsets.'),
      ...tool(
        'apply',
        'Edit',
        { file_path: 'api/views.py', old_string: 'class', new_string: 'class' },
        'The file api/views.py has been updated.',
      ),
      ...usageLimitError(),
    ],
  ],
}

/** A copy that loses the network; the task resumes once it's back, and the copy completes. */
const offline: AgentScript = {
  name: 'offline',
  turns: [copyUntil(connectionLost()), copyCompletes()],
}

/**
 * A long copy, for the message queue: its first turn keeps copying, with the command still running, until it's stopped
 * or the app quits, so messages sent meanwhile stay queued. Resumed after a quit, it copies the rest; a message still
 * queued is delivered when that command finishes, folded into the turn, and the agent answers it (its second turn)
 * before it ends the turn.
 */
const copyInBatches: AgentScript = {
  name: 'copy-in-batches',
  turns: [
    [
      ...turnStart(),
      say("I'll copy the existing uploads to the bucket, then check a sample."),
      ...describeTask(
        'Move image uploads to S3',
        'Move user image uploads from local disk to S3, and copy the existing files over.',
        'Copying existing files: 1,240 of 3,900 done.',
      ),
      toolUse('copy', 'Bash', {
        command: 'python scripts/copy_media_to_s3.py',
        description: 'Copy the existing uploads to S3',
      }),
      waitForInterrupt(),
    ],
    [
      ...turnStart(),
      delay(BEAT_MS),
      say('Noted: the bucket keys keep the original filenames. Checking a sample.'),
      ...tool(
        'sample',
        'Bash',
        { command: 'aws s3 ls s3://acme-uploads/uploads/2025/11/', description: 'List a sample of the bucket' },
        'a7f3.jpg\na7f4.png\na801.jpg',
      ),
      delay(BEAT_MS),
      gladeTool('status-copied', 'set_status', {
        status: 'All 3,900 files copied to S3, keeping their original filenames.',
      }),
      say('All 3,900 files are in the bucket, and their keys keep the original filenames.'),
      result(),
    ],
  ],
  resumeTurn: [
    ...turnStart(),
    say('Glade restarted mid-copy, so I am copying the rest.'),
    ...tool(
      'copy-rest',
      'Bash',
      { command: 'python scripts/copy_media_to_s3.py --resume', description: 'Copy the rest of the uploads to S3' },
      'copied 3,900 of 3,900',
    ),
    delay(BEAT_MS),
    say('The copy finished: all 3,900 files are in the bucket.'),
    result(),
  ],
}

/**
 * What `asks-a-question` says before its questions, at the top of the card: its reply to your message, in Markdown.
 */
export const RELEASE_NOTES_PREAMBLE =
  'I read the 41 PRs merged since `v2.3.0`. The new rate limits on `/search` change what API clients see, so the ' +
  'notes get a short **upgrade guide** too.\n\nA few choices are yours before I draft them.'

/**
 * The questions `asks-a-question` asks before it drafts the release notes: a choice with sketches, two pills, and an
 * optional text question.
 */
export const RELEASE_NOTES_QUESTIONS: readonly Question[] = [
  {
    kind: QuestionKind.Choice,
    prompt: 'How should the notes be laid out?',
    options: [
      {
        id: 'by-type',
        label: 'By type',
        detail: 'Features, fixes, internal. Matches the 2.3 notes.',
        sketch: '# Features\n- Rate limits on /search\n# Fixes\n- Login redirect loop',
      },
      {
        id: 'by-area',
        label: 'By area',
        detail: 'API, dashboard, admin. Easier for integrators to scan.',
        sketch: '# API\n- Rate limits on /search\n# Dashboard\n- Login redirect loop',
      },
    ],
  },
  {
    kind: QuestionKind.Pills,
    prompt: 'Where does the Django 5.2 upgrade go?',
    options: ['Features', 'Internal changes', 'Leave it out'],
  },
  { kind: QuestionKind.Pills, prompt: 'Credit contributors?', options: ['GitHub handles', 'Full names', 'No credits'] },
  {
    kind: QuestionKind.Text,
    prompt: 'Anything to call out in the upgrade guide?',
    placeholder: 'e.g. the new 429s on /search',
    optional: true,
  },
]

/**
 * A turn that asks questions (`ask`) and waits for the answers, however long that takes, then drafts the release notes
 * from them. If the app quits while they're open, answering them after the relaunch carries the turn on (its resume
 * turn).
 */
const asksAQuestion: AgentScript = {
  name: 'asks-a-question',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      ...describeTask(
        'Draft release notes for 2.4',
        'Draft release notes for 2.4 from the PRs merged since the 2.3 tag, grouped into features, fixes and ' +
          'internal changes.',
        'Waiting on layout, credit and upgrade guide questions.',
      ),
      // Said just before asking: it stays in the tool log, since the card has a preamble of its own.
      say('41 PRs since v2.3.0: 9 features, 17 fixes and 15 internal changes.'),
      ask('questions', RELEASE_NOTES_QUESTIONS, RELEASE_NOTES_PREAMBLE),
      delay(BEAT_MS),
      gladeTool('status-drafted', 'set_status', { status: 'Release notes drafted in docs/releases/2.4.md.' }),
      say('Thanks. The release notes for 2.4 are drafted in `docs/releases/2.4.md`, laid out the way you picked.'),
      result(),
    ],
  ],
  resumeTurn: [
    ...turnStart(),
    delay(BEAT_MS),
    gladeTool('status-resumed', 'set_status', { status: 'Release notes drafted in docs/releases/2.4.md.' }),
    say('Got your answers after the restart. The release notes for 2.4 are drafted in `docs/releases/2.4.md`.'),
    result(),
  ],
}

/** The progress summaries `parallel-subagents` ends on, one per subagent still running. */
export const PARALLEL_SUBAGENTS = {
  apiSummary: 'Reading PR 1402, the rate limiting change, to see if API clients need an upgrade guide',
  dashboardSummary: 'Sorting the dashboard PRs into features and fixes',
} as const

/**
 * Three subagents run side by side, splitting the release notes by area: one checks the links in the last notes and
 * finishes, while the other two keep reading PRs (one last said something, the other is in a tool call), each saying
 * what it's doing now, until the turn is stopped, so a spec can watch them run, then see them fail when it stops them.
 * A summary for the link check arrives after it finished, and changes nothing.
 */
const parallelSubagents: AgentScript = {
  name: 'parallel-subagents',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      say("I'll split the PRs by area across three subagents, and check the links in the 2.3 notes meanwhile."),
      ...describeTask(
        'Draft release notes for 2.4',
        'Draft release notes for 2.4 from the PRs merged since the 2.3 tag, grouped into features, fixes and ' +
          'internal changes.',
        'Split the PRs by area across three subagents.',
      ),
      toolUse('api', 'Agent', {
        description: 'API changes',
        prompt: 'Sort the API PRs merged since v2.3.0 into features, fixes and internal changes.',
        subagent_type: 'general-purpose',
      }),
      toolUse('dashboard', 'Agent', {
        description: 'Dashboard changes',
        prompt: 'Sort the dashboard PRs merged since v2.3.0 into features, fixes and internal changes.',
        subagent_type: 'general-purpose',
      }),
      toolUse('links', 'Agent', {
        description: 'Check links in the 2.3 notes',
        prompt: 'Check every link in docs/releases/2.3.md and fix the broken ones.',
        subagent_type: 'general-purpose',
      }),
      say('Reading the API PRs, newest first.', 'api'),
      progress('api', 'Listing the API PRs merged since v2.3.0'),
      ...tool(
        'api-list',
        'Bash',
        { command: 'gh pr list --label api --state merged', description: 'List the merged API PRs' },
        '1409\tAdd per-key throttles\n1402\tRate limit the public API',
        'api',
      ),
      ...tool('links-read', 'Read', { file_path: 'docs/releases/2.3.md' }, '# 2.3\n…', 'links'),
      delay(BEAT_MS),
      ...tool(
        'dashboard-list',
        'Bash',
        { command: 'gh pr list --label dashboard --state merged', description: 'List the merged dashboard PRs' },
        '1418\tMove the charts onto the new query',
        'dashboard',
      ),
      progress('dashboard', PARALLEL_SUBAGENTS.dashboardSummary),
      ...tool(
        'links-fix',
        'Edit',
        { file_path: 'docs/releases/2.3.md', old_string: '/docs/limits', new_string: '/docs/rate-limits' },
        'The file docs/releases/2.3.md has been updated.',
        'links',
      ),
      toolResult('links', 'Found 2 broken links and fixed both in the draft.'),
      // Late: the link check has finished, so it changes nothing.
      progress('links', 'Checking the last links in the 2.3 notes'),
      ...tool(
        'api-view',
        'Bash',
        { command: 'gh pr view 1402 --json title,body', description: 'Read PR 1402' },
        '{"title":"Rate limit the public API"}',
        'api',
      ),
      say('#1418 moves the charts onto the new query, so it belongs under features, not fixes.', 'dashboard'),
      progress('api', PARALLEL_SUBAGENTS.apiSummary),
      toolUse('api-read', 'Read', { file_path: 'api/throttles.py' }, 'api'),
      waitForInterrupt(),
    ],
  ],
}

/** The plan `keeps-todos` makes, as the items of its todo list, with each one's active form. */
export const S3_PLAN: readonly { readonly subject: string; readonly activeForm: string }[] = [
  { subject: 'Find how uploads are stored today', activeForm: 'Finding how uploads are stored' },
  { subject: 'Add an S3 backend for media files', activeForm: 'Adding an S3 backend' },
  { subject: 'Check new uploads land in the bucket', activeForm: 'Checking new uploads' },
  { subject: 'Copy the 3,900 existing files', activeForm: 'Copying the existing files' },
  { subject: 'Spot-check a sample of copied files', activeForm: 'Spot-checking copied files' },
  { subject: 'Update stored paths in the database', activeForm: 'Updating stored paths' },
  { subject: 'Delete local copies', activeForm: 'Deleting local copies' },
]

/**
 * The questions `asks-many-choices` asks: more option cards than fit on one row (five with long labels, and nine), two
 * that do, sketches and a word too long for its card, and pills that wrap, one of them a long unbroken URL.
 */
export const MANY_CHOICES_QUESTIONS: readonly Question[] = [
  {
    kind: QuestionKind.Choice,
    prompt: 'What can I start without asking again? (pick all that apply)',
    multiple: true,
    options: [
      { id: 'sweep', label: 'Sweep PR deleting covered legacy cases', detail: 'Off main, no load run needed' },
      { id: 'rebase', label: 'Rebase + re-measure #2080 and #2048/#2074', detail: 'Remote load runs, one at a time' },
      { id: 'harness', label: 'Fix harness defects #2151–#2154', detail: 'And file the three gaps with no ticket yet' },
      {
        id: 'validator',
        label: 'File the URL-validator/Retry ticket',
        detail: 'Filed only; the fix waits until the ports are done',
      },
      {
        id: 'worktrees',
        label: 'Remove the ~15 finished worktrees + branches',
        detail: 'Unlocked trees whose PRs are merged or reverted only',
      },
    ],
  },
  {
    kind: QuestionKind.Choice,
    prompt: 'How strict should the /search limit be?',
    options: [
      { id: 'thirty', label: '30 a minute', detail: 'Matches /items. A few integrators will see 429s.' },
      { id: 'sixty', label: '60 a minute', detail: 'Twice the others. No current client comes close.' },
    ],
  },
  {
    kind: QuestionKind.Choice,
    prompt: 'Which endpoint gets its own limit first?',
    options: [
      '/search',
      '/items',
      '/users',
      '/orders',
      '/exports',
      '/webhooks',
      '/auth/token',
      '/admin/audit',
      '/health',
    ].map((path) => ({ id: path, label: path })),
  },
  {
    kind: QuestionKind.Choice,
    prompt: 'Where should the limits live?',
    options: [
      {
        id: 'settings',
        label: 'In settings',
        detail: 'Under RATE_LIMITS_PER_ENDPOINT_OVERRIDES_FOR_SEARCH_AND_EXPORTS, reviewed like code.',
        sketch: '# config/settings/base.py\nRATE_LIMITS = {\n    "/search": "30/minute",\n}',
      },
      {
        id: 'environment',
        label: 'In the environment',
        detail: 'One variable per endpoint.',
        sketch: '# .env\nRATE_LIMIT_SEARCH=30/minute',
      },
      {
        id: 'database',
        label: 'api_ratelimit_endpoint_overrides_table',
        detail: 'Editable from the admin.',
        sketch: '# Admin › Rate limits\n/search   30/minute',
      },
    ],
  },
  {
    kind: QuestionKind.Pills,
    prompt: 'Who should hear about the new limits?',
    multiple: true,
    options: [
      'Mobile app team',
      'Partner integrations',
      'Internal dashboards',
      'CLI users',
      'https://partners.acme.example/announcements/rate-limits-for-search-and-exports',
      'Everyone',
    ],
  },
]

/**
 * A turn that asks more choices than fit on a row (`MANY_CHOICES_QUESTIONS`) and waits for the answers, then carries
 * on: for the question card's layout.
 */
const asksManyChoices: AgentScript = {
  name: 'asks-many-choices',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      ...describeTask(
        'Add per-endpoint rate limits',
        'Give each API endpoint its own rate limit, starting with /search.',
        'Waiting on which follow-ups to start and how strict the limits are.',
      ),
      say('The limiter is in. A few choices are yours before I go on.'),
      ask('choices', MANY_CHOICES_QUESTIONS),
      delay(BEAT_MS),
      say('Thanks. I’ll start on those.'),
      result(),
    ],
  ],
}

/** What `keeps-todos` asks while it copies the files. */
export const DELETE_LOCAL_COPIES_QUESTION: Question = {
  kind: QuestionKind.Pills,
  prompt: 'Once the copy is checked, should I delete the local copies?',
  options: ['Delete them', 'Keep them for now'],
}

/** Claude Code's `TaskCreate`, adding an item of the plan (the `n`th, from 1), and its result. */
const createTodo = (item: (typeof S3_PLAN)[number], n: number): ScriptStep[] => [
  ...tool(
    `create-${String(n)}`,
    'TaskCreate',
    { subject: item.subject, description: item.subject, activeForm: item.activeForm },
    `Task #${String(n)} created successfully: ${item.subject}`,
  ),
]

/** Claude Code's `TaskUpdate`, changing item `n` of the plan. */
const updateTodo = (n: number, status: string, extra: ToolInput = {}): ScriptStep[] => [
  ...tool(
    `update-${String(n)}-${status}`,
    'TaskUpdate',
    { taskId: String(n), status, ...extra },
    `Updated task #${String(n)} status`,
  ),
]

/**
 * A turn that keeps a todo list with Claude Code's own todo tools, as the model does unprompted: `TaskCreate` for each
 * step of its plan, then `TaskUpdate` as it starts and finishes each. Partway through (3 of 7 done, copying the files) it
 * asks whether to delete the local copies, and waits; once answered it works through two more steps and ends the turn
 * with 6 of 7 done.
 */
const keepsTodos: AgentScript = {
  name: 'keeps-todos',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      say("I'll plan the move, then work through it step by step."),
      ...describeTask(
        'Move image uploads to S3',
        'Move user image uploads from local disk to S3. New uploads go straight to the bucket; copy the existing ' +
          'files over and update their stored paths.',
        'Planning the move to S3.',
      ),
      ...S3_PLAN.flatMap((item, index) => createTodo(item, index + 1)),
      ...updateTodo(1, 'in_progress'),
      ...tool('settings', 'Read', { file_path: 'config/settings/base.py' }, "MEDIA_ROOT = BASE_DIR / 'media'"),
      ...updateTodo(1, 'completed'),
      ...updateTodo(2, 'in_progress'),
      delay(BEAT_MS),
      ...tool(
        'backend',
        'Edit',
        {
          file_path: 'config/settings/base.py',
          old_string: "MEDIA_ROOT = BASE_DIR / 'media'",
          new_string: "DEFAULT_FILE_STORAGE = 'storages.backends.s3.S3Storage'",
        },
        'The file config/settings/base.py has been updated.',
      ),
      ...updateTodo(2, 'completed'),
      ...updateTodo(3, 'in_progress'),
      ...tool(
        'check',
        'Bash',
        { command: "python manage.py shell -c 'upload_test()'", description: 'Upload a test image' },
        'uploaded to s3://acme-uploads/test.png',
      ),
      ...updateTodo(3, 'completed'),
      ...updateTodo(4, 'in_progress', { activeForm: 'Copying files · 1,240 of 3,900' }),
      gladeTool('status-copying', 'set_status', { status: 'Copying existing files: 1,240 of 3,900 done.' }),
      ask('delete', [DELETE_LOCAL_COPIES_QUESTION]),
      delay(BEAT_MS),
      ...updateTodo(4, 'completed'),
      ...updateTodo(5, 'in_progress'),
      ...tool(
        'spot-check',
        'Bash',
        { command: 'python scripts/check_media.py --sample 50', description: 'Spot-check copied files' },
        '50 of 50 match',
      ),
      ...updateTodo(5, 'completed'),
      ...updateTodo(6, 'in_progress'),
      ...tool(
        'paths',
        'Bash',
        { command: 'python manage.py update_media_paths', description: 'Update stored paths' },
        'updated 3,900 rows',
      ),
      ...updateTodo(6, 'completed'),
      gladeTool('status-done', 'set_status', { status: 'All 3,900 files on S3 with their paths updated.' }),
      say('All 3,900 files are on S3, spot-checked, with their stored paths updated. Deleting the local copies waits.'),
      result(),
    ],
  ],
}

/**
 * A turn that keeps its todo list with `TodoWrite`, Claude Code's older todo tool, which replaces the whole list each
 * call: three steps, checked off one by one, ending with all three done.
 */
const writesTodos: AgentScript = {
  name: 'writes-todos',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      ...describeTask('Fix the flaky login test', 'Make the login test pass every run.', 'Finding the race.'),
      ...tool(
        'plan',
        'TodoWrite',
        {
          todos: [
            { content: 'Reproduce the flake', status: 'in_progress', activeForm: 'Reproducing the flake' },
            { content: 'Fix the race', status: 'pending', activeForm: 'Fixing the race' },
            { content: 'Run the test 200 times', status: 'pending', activeForm: 'Running the test 200 times' },
          ],
        },
        'Todos have been modified successfully.',
      ),
      ...tool('repeat', 'Bash', { command: 'pytest tests/test_login.py --count 50' }, '2 failed, 48 passed'),
      ...tool(
        'progress',
        'TodoWrite',
        {
          todos: [
            { content: 'Reproduce the flake', status: 'completed', activeForm: 'Reproducing the flake' },
            { content: 'Fix the race', status: 'in_progress', activeForm: 'Fixing the race' },
            { content: 'Run the test 200 times', status: 'pending', activeForm: 'Running the test 200 times' },
          ],
        },
        'Todos have been modified successfully.',
      ),
      delay(BEAT_MS),
      ...tool(
        'fix',
        'Edit',
        { file_path: 'tests/test_login.py', old_string: 'client.get(', new_string: 'session.save()\n    client.get(' },
        'The file tests/test_login.py has been updated.',
      ),
      ...tool('verify', 'Bash', { command: 'pytest tests/test_login.py --count 200' }, '200 passed'),
      ...tool(
        'done',
        'TodoWrite',
        {
          todos: [
            { content: 'Reproduce the flake', status: 'completed', activeForm: 'Reproducing the flake' },
            { content: 'Fix the race', status: 'completed', activeForm: 'Fixing the race' },
            { content: 'Run the test 200 times', status: 'completed', activeForm: 'Running the test 200 times' },
          ],
        },
        'Todos have been modified successfully.',
      ),
      gladeTool('status-fixed', 'set_status', { status: 'Found the race; the fix passes 200 runs.' }),
      say('The test read the session before it was saved. It now saves first, and passes 200 runs in a row.'),
      result(),
    ],
  ],
}

/**
 * A turn that writes up a doc and shows it to you with `show_file`, at the line to check. The doc must be in the
 * workspace (a spec makes it) for the Glade tool to open it.
 */
const showsAFile: AgentScript = {
  name: 'shows-a-file',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      ...describeTask(
        'Document the rate limits',
        'Write up the public API rate limits for clients.',
        'Writing up the rate limits.',
      ),
      ...tool(
        'read-limits',
        'Read',
        { file_path: 'docs/rate-limits.md' },
        '# Rate limits\n\nEvery request counts against the key that made it.',
      ),
      ...tool(
        'edit-limits',
        'Edit',
        {
          file_path: 'docs/rate-limits.md',
          old_string: '| /search | 120 per minute |',
          new_string: '| /search | 60 per minute |',
        },
        'The file docs/rate-limits.md has been updated.',
      ),
      gladeTool('show-limits', 'show_file', { path: 'docs/rate-limits.md', line: 8 }),
      gladeTool('status-done', 'set_status', { status: 'Documented the limits; /search gets 60 a minute.' }),
      say('The limits are in `docs/rate-limits.md`. Line 8 has the tighter /search limit for you to check.'),
      result(),
    ],
  ],
}

/**
 * A turn that writes release notes and an upgrade guide and declares both as artifacts with `add_artifact`. The files
 * must be in the workspace (a spec makes them: the scripted writes don't) for the Glade tool to declare them.
 */
const declaresArtifacts: AgentScript = {
  name: 'declares-artifacts',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      ...describeTask(
        'Draft release notes for 2.4',
        'Draft release notes for 2.4 from the PRs merged since the 2.3 tag, with a short upgrade guide.',
        'Drafting the release notes.',
      ),
      ...tool(
        'write-notes',
        'Write',
        { file_path: 'docs/releases/2.4.md', content: '# Release notes 2.4\n' },
        'File created successfully at: docs/releases/2.4.md',
      ),
      ...tool(
        'write-guide',
        'Write',
        { file_path: 'docs/releases/2.4-upgrade.md', content: '# Upgrading to 2.4\n' },
        'File created successfully at: docs/releases/2.4-upgrade.md',
      ),
      gladeTool('add-notes', 'add_artifact', { path: 'docs/releases/2.4.md', title: 'Release notes 2.4' }),
      gladeTool('add-guide', 'add_artifact', { path: 'docs/releases/2.4-upgrade.md', title: 'Upgrade guide' }),
      gladeTool('status-done', 'set_status', { status: 'Release notes and an upgrade guide are drafted.' }),
      say('The release notes and an upgrade guide are ready in Artifacts.'),
      result(),
    ],
  ],
}

/**
 * A build started in the background: the turn that starts it ends at once, and when the build finishes the agent
 * starts a turn of its own (a `wake`) to read its output and report, with no message from you. It takes a while to
 * read the output, so a spec can see it working. A message sent after that gets a short reply.
 */
const finishesInBackground: AgentScript = {
  name: 'finishes-in-background',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      ...describeTask(
        'Build the docs site',
        'Build the docs site and check it for broken links.',
        'Building the docs.',
      ),
      ...tool(
        'build',
        'Bash',
        { command: 'npm run build:docs', description: 'Build the docs site', run_in_background: true },
        'Command running in background with ID: b4k2x9q. Output is being written to: tasks/b4k2x9q.output. You ' +
          'will be notified when it completes.',
      ),
      wake(
        [
          ...turnStart(),
          delay(BEAT_MS),
          say('The docs build finished. Checking its output for broken links.'),
          // Long enough for a spec to see the task working on it, and to look away before it replies.
          toolUse('output', 'Read', { file_path: 'tasks/b4k2x9q.output' }),
          delay(BEAT_MS * 8),
          toolResult('output', 'Built 48 pages.\nNo broken links.'),
          gladeTool('status-built', 'set_status', { status: 'The docs site is built, with no broken links.' }),
          say('The docs site built cleanly: 48 pages and no broken links.'),
          result(),
        ],
        { ms: BEAT_MS * 4, task: 'build', summary: 'Background command "Build the docs site" completed (exit code 0)' },
      ),
      say("I've started the docs build in the background. I'll report back when it finishes."),
      result(),
    ],
    [...turnStart(), delay(BEAT_MS), say('The docs site is live at /docs.'), result()],
  ],
}

/** What `background-subagents` says when its turns end, and what its subagents come to. */
export const BACKGROUND_SUBAGENTS = {
  started: "I've started three subagents on the slow checkout. I'll report back as they finish.",
  meanwhile: 'The subagents are still at it. The cart cache is the likeliest suspect so far.',
  profiled: 'Checkout runs one query per cart item: an N+1 in load_cart. Batching it takes p95 from 840 ms to 95 ms.',
  cacheFailed: "Couldn't reach the Redis staging instance: connection refused.",
  reported: 'The query profile is back: checkout has an N+1 in load_cart. Batching it should take p95 to about 95 ms.',
  /** What the query profile says it's doing while it runs (its progress summary). */
  queriesSummary: 'Timing the checkout queries against the staging copy',
} as const

/**
 * Three subagents look into a slow endpoint in the background (`run_in_background`), so the turn that starts them ends
 * at once and the task can be talked to while they work (a message sent meanwhile gets a short reply). The cart cache
 * check fails after a couple of seconds, with a call still running; the bisect runs until it's stopped; the query
 * profile finishes a few seconds later, and the agent starts a turn of its own to report it.
 */
const backgroundSubagents: AgentScript = {
  name: 'background-subagents',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      ...describeTask(
        'Find why checkout is slow',
        'Find why the checkout endpoint got slower since 2.3, and fix it.',
        'Three subagents are looking into the slow checkout.',
      ),
      background(
        'queries',
        {
          description: 'Profile the checkout queries',
          prompt: 'Time each query the checkout endpoint runs against the staging copy, and find the slow ones.',
          subagent_type: 'general-purpose',
        },
        [
          delay(BEAT_MS * 2),
          say('Timing the checkout queries against the staging copy.', 'queries'),
          progress('queries', BACKGROUND_SUBAGENTS.queriesSummary),
          ...tool(
            'queries-read',
            'Read',
            { file_path: 'api/checkout/queries.py' },
            'def load_cart(cart_id):\n    …',
            'queries',
          ),
          toolUse(
            'queries-time',
            'Bash',
            { command: 'python scripts/time_queries.py checkout', description: 'Time the checkout queries' },
            'queries',
          ),
          delay(BEAT_MS * 30),
          toolResult('queries-time', 'load_cart  38 queries  812 ms\nload_prices  1 query  21 ms'),
          say('load_cart runs a query per cart item.', 'queries'),
          delay(BEAT_MS * 6),
        ],
        {
          summary: BACKGROUND_SUBAGENTS.profiled,
          turn: [...turnStart(), delay(BEAT_MS), say(BACKGROUND_SUBAGENTS.reported), result()],
        },
      ),
      background(
        'cache',
        {
          description: 'Check the cart cache',
          prompt: 'Check whether the cart cache is being hit on checkout.',
          subagent_type: 'general-purpose',
        },
        [
          delay(BEAT_MS * 2),
          ...tool(
            'cache-grep',
            'Grep',
            { pattern: 'cart_cache', path: 'api/checkout' },
            'api/checkout/cart.py:14',
            'cache',
          ),
          toolUse(
            'cache-stats',
            'Bash',
            { command: 'redis-cli -h staging-cache info stats', description: 'Read the cache stats' },
            'cache',
          ),
          delay(BEAT_MS * 14),
        ],
        { outcome: 'failed', summary: BACKGROUND_SUBAGENTS.cacheFailed },
      ),
      background(
        'bisect',
        {
          description: 'Bisect the slowdown',
          prompt: 'Find the commit since v2.3.0 that made checkout slower.',
          subagent_type: 'general-purpose',
        },
        [
          delay(BEAT_MS * 3),
          ...tool(
            'bisect-log',
            'Bash',
            { command: 'git log --oneline v2.3.0..HEAD -- api/checkout', description: 'List the checkout commits' },
            'a41c9e2 Load cart items lazily\n7be01d4 Add gift cards',
            'bisect',
          ),
          toolUse(
            'bisect-run',
            'Bash',
            { command: 'git bisect run ./scripts/bench-checkout.sh', description: 'Bisect the checkout benchmark' },
            'bisect',
          ),
          // Until it's stopped.
          delay(10 * 60_000),
        ],
        { summary: 'a41c9e2 made checkout slower.' },
      ),
      say(BACKGROUND_SUBAGENTS.started),
      result(),
    ],
    [...turnStart(), delay(BEAT_MS), say(BACKGROUND_SUBAGENTS.meanwhile), result()],
  ],
}

/** What `stop-spares-background` starts, and says, for the spec on Stop leaving background work running. */
export const STOP_SPARES_BACKGROUND = {
  prompt: 'Find the commit that slowed checkout, and keep an eye on the CI for PR #42 meanwhile.',
  title: 'Find the commit that slowed checkout',
  bisect: 'Bisect the slowdown',
  ci: 'CI checks on PR #42',
  ciCommand: 'gh pr checks 42 --watch --interval 30 | grep --line-buffered -E "pass|fail"',
  started: "I've started a subagent bisecting the slowdown, and I'm watching the CI on PR #42.",
  next: 'Benchmark the cart endpoint too.',
  benchmarking: 'Benchmarking the cart endpoint meanwhile.',
} as const

/**
 * Leaves a subagent bisecting in the background and a `Monitor` on the CI running, both until they're stopped, then
 * starts a long benchmark in the next turn, which runs until it's stopped. Stop on that turn leaves the other two
 * running, as the SDK does for Glade's options (`docs/sdk-notes.md` §7), so each can be stopped from its own tab.
 */
const stopSparesBackground: AgentScript = {
  name: 'stop-spares-background',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      ...describeTask(
        STOP_SPARES_BACKGROUND.title,
        'Find the commit since v2.3.0 that made checkout slower.',
        'Bisecting the checkout slowdown.',
      ),
      background(
        'bisect',
        {
          description: STOP_SPARES_BACKGROUND.bisect,
          prompt: 'Find the commit since v2.3.0 that made checkout slower.',
          subagent_type: 'general-purpose',
        },
        [
          delay(BEAT_MS),
          toolUse(
            'bisect-run',
            'Bash',
            { command: 'git bisect run ./scripts/bench-checkout.sh', description: 'Bisect the checkout benchmark' },
            'bisect',
          ),
          // Until it's stopped.
          delay(10 * 60_000),
        ],
        { summary: 'a41c9e2 made checkout slower.' },
      ),
      ...tool(
        'ci',
        'Monitor',
        { description: STOP_SPARES_BACKGROUND.ci, timeout_ms: 1_800_000, command: STOP_SPARES_BACKGROUND.ciCommand },
        'Monitor started (task bm7c2x1, expires in 30m unless the source ends first). You will be notified on each ' +
          'event.',
      ),
      say(STOP_SPARES_BACKGROUND.started),
      result(),
    ],
    [
      ...turnStart(),
      say(STOP_SPARES_BACKGROUND.benchmarking),
      toolUse('bench', 'Bash', { command: 'npm run bench:cart', description: 'Benchmark the cart endpoint' }),
      waitForInterrupt(),
    ],
  ],
}

/** What `subagent-calls` says when its turn ends. */
export const SUBAGENT_CALLS_REPLY =
  'The 2.4 notes are drafted: the API rate limit goes first under features. The dashboard cache check failed, and the ' +
  'link check is still going in the background.'

/**
 * Whose tool calls are whose: the agent reads the changelog itself, starts two subagents in the foreground that make
 * their calls interleaved (the API one starts a nested subagent of its own; one of the dashboard one's calls fails),
 * writes the draft itself, and starts a third in the background that checks the links and finishes after the turn.
 */
const subagentCalls: AgentScript = {
  name: 'subagent-calls',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      ...describeTask(
        'Draft release notes for 2.4',
        'Draft release notes for 2.4 from the PRs merged since the 2.3 tag.',
        'Sorting the PRs with two subagents.',
      ),
      ...tool('changelog', 'Read', { file_path: 'CHANGELOG.md' }, '# Changelog\n\n## 2.3.0\n…'),
      toolUse('api', 'Agent', {
        description: 'API changes',
        prompt: 'Sort the API PRs merged since v2.3.0 into features, fixes and internal changes.',
        subagent_type: 'general-purpose',
      }),
      toolUse('dashboard', 'Agent', {
        description: 'Dashboard changes',
        prompt: 'Sort the dashboard PRs merged since v2.3.0 into features, fixes and internal changes.',
        subagent_type: 'general-purpose',
      }),
      say('Listing the merged API PRs.', 'api'),
      toolUse('api-list', 'Bash', { command: 'gh pr list --label api --state merged' }, 'api'),
      toolUse('dashboard-cache', 'Bash', { command: 'redis-cli -h staging-cache info stats' }, 'dashboard'),
      delay(BEAT_MS),
      toolResult('api-list', '1409\tAdd per-key throttles\n1402\tRate limit the public API'),
      toolResult('dashboard-cache', 'Could not connect to Redis at staging-cache:6379: Connection refused', true),
      toolUse('api-pr', 'Agent', { description: 'Read PR 1402', prompt: 'Summarise PR 1402.' }, 'api'),
      ...tool(
        'api-pr-view',
        'Bash',
        { command: 'gh pr view 1402 --json title,body' },
        '{"title":"Rate limit"}',
        'api-pr',
      ),
      ...tool(
        'dashboard-list',
        'Bash',
        { command: 'gh pr list --label dashboard' },
        '1418\tNew chart query',
        'dashboard',
      ),
      ...tool('api-pr-read', 'Read', { file_path: 'api/throttles.py' }, 'RATE = 10', 'api-pr'),
      delay(BEAT_MS),
      toolResult('api-pr', 'PR 1402 rate limits the public API to 10 requests a second.'),
      ...tool('dashboard-read', 'Read', { file_path: 'web/charts.ts' }, 'export const query = …', 'dashboard'),
      toolResult('dashboard', "#1418 is a feature. Couldn't check the cache: Redis refused the connection."),
      toolResult('api', '#1402 and #1409 are features: the public API is rate limited.'),
      ...tool(
        'draft',
        'Write',
        { file_path: 'docs/releases/2.4.md', content: '# 2.4\n\n## Features\n\n- Rate limits (#1402)\n' },
        'File created successfully at: docs/releases/2.4.md',
      ),
      background(
        'links',
        {
          description: 'Check links in the 2.3 notes',
          prompt: 'Check every link in docs/releases/2.3.md.',
          subagent_type: 'general-purpose',
        },
        [
          delay(BEAT_MS * 2),
          ...tool('links-read', 'Read', { file_path: 'docs/releases/2.3.md' }, '# 2.3\n…', 'links'),
          delay(BEAT_MS * 2),
          ...tool('links-curl', 'Bash', { command: 'curl -sI https://example.com/docs/limits' }, 'HTTP/2 200', 'links'),
          delay(BEAT_MS * 2),
        ],
        { summary: 'Every link in the 2.3 notes works.' },
      ),
      gladeTool('status-drafted', 'set_status', { status: 'Drafted the 2.4 notes.' }),
      say(SUBAGENT_CALLS_REPLY),
      result(),
    ],
  ],
}

/** What the `asks-permission` script's agent does and says. */
export const ASKS_PERMISSION = {
  edit: {
    file_path: 'CHANGELOG.md',
    old_string: '## Unreleased',
    new_string: '## Unreleased\n\n- Retries now back off exponentially.',
  },
  command: 'npm test',
  reply: 'Added the retry change to the changelog and ran the tests: all 148 pass.',
} as const

/**
 * A turn whose edit and command ask permission first, in the ask mode: reads go ahead, the `Edit` and the `Bash` call
 * each wait on a permission request, then the agent replies. In Allow all, nothing asks.
 */
const asksPermission: AgentScript = {
  name: 'asks-permission',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      ...describeTask(
        'Note the retry change',
        'Add the retry change to the changelog and check the tests pass.',
        'Updating the changelog.',
      ),
      say("I'll add the retry change to the changelog, then run the tests."),
      ...tool('read', 'Read', { file_path: 'CHANGELOG.md' }, '# Changelog\n\n## Unreleased\n'),
      permission('edit', 'Edit', ASKS_PERMISSION.edit, 'The file CHANGELOG.md has been updated.', {
        description: 'CHANGELOG.md',
        suggestions: [
          { type: PermissionUpdateType.SetMode, mode: 'acceptEdits', destination: PermissionDestination.Session },
        ],
      }),
      permission(
        'test',
        'Bash',
        { command: ASKS_PERMISSION.command, description: 'Run the test suite' },
        'Test Files  12 passed (12)\n     Tests  148 passed (148)',
        { description: 'Run the test suite', suggestions: bashSuggestions(ASKS_PERMISSION.command) },
      ),
      say(ASKS_PERMISSION.reply),
      result(),
    ],
  ],
}

/** What the `asks-permission-from-a-subagent` script's agent and subagent do and say. */
export const SUBAGENT_PERMISSION = {
  subagent: 'Upgrade guide',
  title: 'Claude wants to create docs/upgrade-2.4.md',
  file: 'docs/upgrade-2.4.md',
  content:
    '# Upgrading to 2.4\n\nClients that call /search more than 10 times a second now get 429 Too Many Requests.\n',
  command: 'rm -rf dist',
  reply: 'The upgrade guide is written up.',
} as const

/**
 * A turn in which the agent's own `Bash` call asks permission, then a subagent's `Write`, which Claude Code marks as not
 * to be approved by a stray key (`defaultToNo`) and titles; then the agent replies. In Allow all, nothing asks.
 */
const asksPermissionFromASubagent: AgentScript = {
  name: 'asks-permission-from-a-subagent',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      ...describeTask(
        'Write the 2.4 upgrade guide',
        'Write the upgrade guide for 2.4, with a subagent drafting it.',
        'Drafting the upgrade guide with a subagent.',
      ),
      permission('clean', 'Bash', { command: SUBAGENT_PERMISSION.command, description: 'Remove the old build' }, '', {
        suggestions: bashSuggestions(SUBAGENT_PERMISSION.command),
      }),
      toolUse('guide', 'Agent', {
        description: SUBAGENT_PERMISSION.subagent,
        prompt: 'Write the 2.4 upgrade guide.',
        subagent_type: 'general-purpose',
      }),
      permission(
        'guide-write',
        'Write',
        { file_path: SUBAGENT_PERMISSION.file, content: SUBAGENT_PERMISSION.content },
        `File created successfully at: ${SUBAGENT_PERMISSION.file}`,
        { parent: 'guide', title: SUBAGENT_PERMISSION.title, defaultToNo: true, description: SUBAGENT_PERMISSION.file },
      ),
      toolResult('guide', 'Wrote the upgrade guide.'),
      say(SUBAGENT_PERMISSION.reply),
      result(),
    ],
  ],
}

/** What the `allows-for-task` script's agent does and says. */
export const ALLOWS_FOR_TASK = {
  prefix: 'npm test',
  command: 'npm test',
  watch: 'npm test -- --watch',
  compound: 'npm test && rm -rf build',
  edit: { file_path: 'CHANGELOG.md', old_string: '## Unreleased', new_string: '## Unreleased\n\n- Retries back off.' },
  editAgain: { file_path: 'README.md', old_string: 'Retries: none', new_string: 'Retries: exponential backoff' },
  reply: 'Ran the tests and noted the retry change in the changelog and the README.',
} as const

/** The edit step's suggestions, as Claude Code makes them for `Edit`: only a switch to `acceptEdits`. */
const EDIT_SUGGESTIONS: readonly PermissionSuggestion[] = [
  { type: PermissionUpdateType.SetMode, mode: 'acceptEdits', destination: PermissionDestination.Session },
]

/**
 * A turn for Allow for this task, in the ask mode: `npm test` asks (suggesting the prefix rule `npm test *`), then
 * `npm test -- --watch`, which that rule covers, then `npm test && rm -rf build`, which it doesn't; then two `Edit`s,
 * the second of which a rule for `Edit` covers. Each message plays the same turn, so a later turn, or the task's
 * session after a relaunch, shows which rules it still has.
 */
const allowsForTask: AgentScript = {
  name: 'allows-for-task',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      ...describeTask('Run the tests', 'Run the tests and note the retry change.', 'Running the tests.'),
      permission('test', 'Bash', { command: ALLOWS_FOR_TASK.command }, 'Tests  148 passed (148)', {
        description: 'Run the test suite',
        suggestions: bashPrefixSuggestions(ALLOWS_FOR_TASK.prefix),
      }),
      permission('watch', 'Bash', { command: ALLOWS_FOR_TASK.watch }, 'Watching for changes', {
        description: 'Run the tests in watch mode',
        suggestions: bashPrefixSuggestions(ALLOWS_FOR_TASK.prefix),
      }),
      permission('compound', 'Bash', { command: ALLOWS_FOR_TASK.compound }, 'Tests  148 passed (148)', {
        description: 'Run the tests, then remove the build',
        suggestions: bashPrefixSuggestions(ALLOWS_FOR_TASK.prefix),
      }),
      permission('edit', 'Edit', ALLOWS_FOR_TASK.edit, 'The file CHANGELOG.md has been updated.', {
        description: 'CHANGELOG.md',
        suggestions: EDIT_SUGGESTIONS,
      }),
      permission('edit-again', 'Edit', ALLOWS_FOR_TASK.editAgain, 'The file README.md has been updated.', {
        description: 'README.md',
        suggestions: EDIT_SUGGESTIONS,
      }),
      say(ALLOWS_FOR_TASK.reply),
      result(),
    ],
  ],
}

/** What the `permission-at-quit` script's agent does and says. */
export const PERMISSION_AT_QUIT = {
  command: 'npm run db:migrate',
  description: 'Run the database migrations',
  output: 'Applied 3 migrations: 0041, 0042, 0043.',
  resumed: 'Glade restarted before the migrations ran, so I am running them now.',
  reply: 'The migrations ran after the restart: 0041 to 0043 are applied.',
} as const

/** The `permission-at-quit` script's command, as it asks each time. */
const migrate = (id: string): PermissionStep =>
  permission(
    id,
    'Bash',
    { command: PERMISSION_AT_QUIT.command, description: PERMISSION_AT_QUIT.description },
    PERMISSION_AT_QUIT.output,
    {
      description: PERMISSION_AT_QUIT.description,
      suggestions: bashPrefixSuggestions(PERMISSION_AT_QUIT.command),
    },
  )

/**
 * A turn whose command waits on permission, for quitting with its card open. Once you decide on it after the relaunch,
 * the resume turn makes the call again, with the same input: allowed, it runs without asking again, and the agent
 * replies.
 */
const permissionAtQuit: AgentScript = {
  name: 'permission-at-quit',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      ...describeTask('Run the migrations', 'Run the pending database migrations.', 'Running the migrations.'),
      say("I'll run the pending database migrations."),
      migrate('migrate'),
      say('The migrations ran: 0041 to 0043 are applied.'),
      result(),
    ],
  ],
  resumeTurn: [
    ...turnStart(),
    delay(BEAT_MS),
    say(PERMISSION_AT_QUIT.resumed),
    migrate('migrate-again'),
    say(PERMISSION_AT_QUIT.reply),
    result(),
  ],
}

/** What the follow-up scripts say, for their specs: `watches-ci`, `checks-back-later` and `scheduled-check`. */
export const FOLLOW_UPS = {
  watching: "I'm watching the CI checks on PR #42. I'll report each one that fails, and when the run is done.",
  checkFailed: 'A CI check failed: the unit tests. Reading its log.',
  checkEvent: 'unit-tests\tfail\t2m13s\thttps://ci.example.com/runs/8812',
  failed: 'The unit tests failed on CI: the UTC formatting test in test/date.test.ts builds its date in local time.',
  runDone: 'The CI run on PR #42 is done: lint and build passed, and the unit tests failed on the date test.',
  deploying: "The docs deploy has started. It takes about five minutes, so I'll check back once it's had time.",
  checkingDeploy: 'Checking whether the docs rollout finished.',
  deployed: 'The docs rollout finished: all three regions serve the new build.',
  scheduled: "I've scheduled a check for 2:30 pm, when the staging migration should be done.",
  checkingMigration: 'Checking the staging migration.',
  migrated: 'The staging migration finished at 2:12 pm: all 14 steps ran, and the schema is at version 58.',
} as const

/**
 * Watches the CI checks on a PR with a `Monitor` (`docs/sdk-notes.md` §11): the turn that arms it ends at once, the
 * failing check wakes the agent to read its log (taking a while, so a spec can see it working, stop it or look away),
 * and the watch ending wakes it again to sum the run up. Stopping the turn a check woke doesn't end the watch.
 */
const watchesCi: AgentScript = {
  name: 'watches-ci',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      ...describeTask(
        'Watch the CI run on PR #42',
        'Watch the CI checks on PR #42 and report what fails.',
        'Watching the CI checks on PR #42.',
      ),
      ...tool(
        'watch',
        'Monitor',
        {
          description: 'CI checks on PR #42',
          timeout_ms: 1_800_000,
          command: 'gh pr checks 42 --watch --interval 30 | grep --line-buffered -E "pass|fail"',
        },
        'Monitor started (task bm7c2x1, expires in 30m unless the source ends first; you get one notice at expiry — ' +
          're-arm if you still need the watch). You will be notified on each event.',
      ),
      wake(
        [
          ...turnStart(),
          delay(BEAT_MS),
          say(FOLLOW_UPS.checkFailed),
          toolUse('log', 'Bash', { command: 'gh run view 8812 --log-failed', description: 'Read the failed log' }),
          // Long enough for a spec to see the task working on it, and to stop it or look away before it replies.
          delay(BEAT_MS * 10),
          toolResult('log', 'FAIL test/date.test.ts > formats in UTC\nExpected "2026-09-25", got "2026-09-24"'),
          gladeTool('status-failed', 'set_status', { status: 'The unit tests fail on CI: the date test.' }),
          say(FOLLOW_UPS.failed),
          result(),
        ],
        { cause: WakeCause.MonitorEvent, ms: BEAT_MS * 4, task: 'watch', event: FOLLOW_UPS.checkEvent },
      ),
      wake([...turnStart(), delay(BEAT_MS), say(FOLLOW_UPS.runDone), result()], {
        ms: BEAT_MS * 6,
        task: 'watch',
        summary: 'Monitor "CI checks on PR #42" stream ended',
      }),
      say(FOLLOW_UPS.watching),
      result(),
    ],
  ],
}

/**
 * Starts a deploy and schedules its own check on it with `ScheduleWakeup` (`docs/sdk-notes.md` §11): the turn ends at
 * once, and the wakeup firing starts a turn that checks the rollout, taking a while, so a spec can see it working.
 */
const checksBackLater: AgentScript = {
  name: 'checks-back-later',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      ...describeTask(
        'Deploy the docs site',
        'Deploy the docs site and check that the rollout finishes.',
        'Deploying the docs site.',
      ),
      ...tool(
        'deploy',
        'Bash',
        { command: 'npm run deploy:docs', description: 'Start the docs deploy' },
        'Deploy started: the rollout takes about 5 minutes.',
      ),
      ...tool(
        'wakeup',
        'ScheduleWakeup',
        {
          delaySeconds: 300,
          reason: 'Check the docs rollout once it has had time to finish',
          prompt: 'Check whether the docs rollout finished, and report.',
          noop: false,
        },
        'Next wakeup scheduled for 14:05:00 (in 300s). Nothing more to do this turn — the harness re-invokes you ' +
          'when the wakeup fires or a task-notification arrives.',
      ),
      wake(
        [
          ...turnStart(),
          delay(BEAT_MS),
          say(FOLLOW_UPS.checkingDeploy),
          toolUse('rollout', 'Bash', { command: 'npm run deploy:status', description: 'Check the rollout' }),
          delay(BEAT_MS * 10),
          toolResult('rollout', 'Rollout complete: 3 of 3 regions serve build 2026.09.25-1.'),
          gladeTool('status-deployed', 'set_status', { status: 'The docs site is deployed.' }),
          say(FOLLOW_UPS.deployed),
          result(),
        ],
        { cause: WakeCause.Scheduled, ms: BEAT_MS * 4, job: 'wakeup' },
      ),
      say(FOLLOW_UPS.deploying),
      result(),
    ],
  ],
}

/**
 * Schedules a one-off check for later with `CronCreate` (`docs/sdk-notes.md` §11): the turn ends at once, and the job
 * firing starts a turn that checks the migration, taking a while, so a spec can see it working.
 */
const scheduledCheck: AgentScript = {
  name: 'scheduled-check',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      ...describeTask(
        'Check the staging migration',
        'Check that the staging migration finishes this afternoon.',
        'A check on the staging migration is scheduled for 2:30 pm.',
      ),
      toolUse('cron', 'CronCreate', {
        cron: '30 14 25 9 *',
        prompt: 'Check whether the staging migration finished, and report.',
        recurring: false,
        durable: false,
      }),
      toolResult(
        'cron',
        'Scheduled one-shot task c3f81a2e (30 14 25 9 *). Session-only (not written to disk, dies when Claude ' +
          'exits). It will fire once then auto-delete.',
        false,
        { id: 'c3f81a2e', humanSchedule: 'Once at 2:30 PM on Sep 25' },
      ),
      wake(
        [
          ...turnStart(),
          delay(BEAT_MS),
          say(FOLLOW_UPS.checkingMigration),
          toolUse('migration', 'Bash', { command: 'npm run db:status -- --env staging', description: 'Check it' }),
          delay(BEAT_MS * 10),
          toolResult('migration', 'staging: 14 of 14 steps applied (finished 14:12); schema version 58'),
          gladeTool('status-migrated', 'set_status', { status: 'The staging migration is done.' }),
          say(FOLLOW_UPS.migrated),
          result(),
        ],
        { cause: WakeCause.Scheduled, ms: BEAT_MS * 4, job: 'cron' },
      ),
      say(FOLLOW_UPS.scheduled),
      result(),
    ],
  ],
}

/** What the `watches-things` script's agent starts, and says, for the Watchers tab's specs and screenshots. */
export const WATCHES_THINGS = {
  prompt:
    'Watch the CI on PR #42, run the integration tests and build the docs in the background, check the docs ' +
    'rollout once it has had time, and keep an eye on the staging queue.',
  title: 'Watch the CI run on PR #42',
  ci: 'CI checks on PR #42',
  ciCommand: 'gh pr checks 42 --watch --interval 30 | grep --line-buffered -E "pass|fail"',
  ciFailed: 'unit-tests\tfail\t2m13s\thttps://ci.example.com/runs/8812',
  ciPassed: 'lint\tpass\t41s\thttps://ci.example.com/runs/8813',
  tests: 'Integration tests',
  testsCommand: 'npm run test:integration -- --reporter=dot',
  docs: 'Build the docs site',
  docsCommand: 'npm run build:docs',
  docsFailed: 'Background command "Build the docs site" failed with exit code 1',
  rollout: 'Check the docs rollout once it has had time to finish',
  rolloutPrompt: 'Check whether the docs rollout finished, and report.',
  queue: 'Check the staging queue depth, and report if it is over 1,000.',
  queueCron: '*/10 * * * *',
  queueSchedule: 'Every 10 minutes',
  queueJob: 'c7a1e04b',
  started:
    "I'm watching the CI checks on PR #42, the integration tests and the docs build are running in the background, " +
    "I'll check the docs rollout in 5 minutes, and I'll look at the staging queue every 10 minutes.",
  checkFailed: 'A CI check failed: the unit tests. The UTC formatting test builds its date in local time.',
  docsBuildFailed: 'The docs build failed: a broken link in docs/upgrade.md. The integration tests are still running.',
  queueChecked: 'The staging queue is at 212 jobs, well under 1,000.',
  lintPassed: 'Lint passed on CI. Still waiting on the other checks.',
  again: "Still on it: the watchers I left are in the Watchers tab, and I'll report when they wake me.",
} as const

/** What the `subagent-background-work` script's agent and subagent start, and say. */
export const SUBAGENT_BACKGROUND_WORK = {
  prompt: 'PR #42 is red on the flaky checkout test. Get it green, and keep an eye on the staging deploy meanwhile.',
  title: 'Get PR #42 green',
  /** The task's own background command. */
  deploy: 'Tail the staging deploy log',
  deployCommand: 'tail -F logs/deploy-staging.log',
  /** The subagent, and what it runs: in the foreground, then two commands in the background. */
  subagent: 'Fix the flaky checkout test',
  unitTests: 'Run the checkout unit tests',
  unitTestsCommand: 'npm test -- api/checkout',
  lint: 'Lint the checkout module',
  lintCommand: 'npm run lint -- api/checkout',
  lintDone: 'Background command "Lint the checkout module" completed (exit code 0)',
  e2e: 'Run the checkout e2e suite',
  e2eCommand: 'npm run test:e2e -- --grep checkout',
  waiting: 'The e2e suite is running; I’ll check the retry fix once it’s done.',
  started: "A subagent is on the flaky checkout test, and I'm tailing the staging deploy log.",
  again: 'Still on it: the subagent is waiting on the e2e suite.',
} as const

/**
 * A task whose subagent leaves work running in the background (#291): the agent tails the deploy log in the background
 * itself, and starts a subagent in the background that runs the unit tests in the foreground (a task of the SDK's, not
 * a watcher), then lints and runs the e2e suite in the background. The lint finishes a moment later, reported as the
 * SDK reports a subagent's (no turn of the agent's); the e2e suite and the subagent run until stopped.
 */
const subagentBackgroundWork: AgentScript = {
  name: 'subagent-background-work',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      ...describeTask(
        SUBAGENT_BACKGROUND_WORK.title,
        'Get the checks on PR #42 green, fixing the flaky checkout test, and watch the staging deploy.',
        'A subagent is fixing the flaky checkout test.',
      ),
      ...tool(
        'deploy',
        'Bash',
        {
          command: SUBAGENT_BACKGROUND_WORK.deployCommand,
          description: SUBAGENT_BACKGROUND_WORK.deploy,
          run_in_background: true,
        },
        'Command running in background with ID: b2d7k4m. Output is being written to: tasks/b2d7k4m.output.',
      ),
      background(
        'fixer',
        {
          description: SUBAGENT_BACKGROUND_WORK.subagent,
          prompt: 'The checkout e2e test fails one run in five on PR #42. Find why, fix it, and check the fix.',
          subagent_type: 'general-purpose',
        },
        [
          delay(BEAT_MS * 2),
          say('Reproducing the flaky test first.', 'fixer'),
          ...tool(
            'fixer-unit',
            'Bash',
            {
              command: SUBAGENT_BACKGROUND_WORK.unitTestsCommand,
              description: SUBAGENT_BACKGROUND_WORK.unitTests,
            },
            '48 passed (3.1s)',
            'fixer',
          ),
          ...tool(
            'fixer-lint',
            'Bash',
            {
              command: SUBAGENT_BACKGROUND_WORK.lintCommand,
              description: SUBAGENT_BACKGROUND_WORK.lint,
              run_in_background: true,
            },
            'Command running in background with ID: b6q1w8r. Output is being written to: tasks/b6q1w8r.output.',
            'fixer',
          ),
          ...tool(
            'fixer-e2e',
            'Bash',
            {
              command: SUBAGENT_BACKGROUND_WORK.e2eCommand,
              description: SUBAGENT_BACKGROUND_WORK.e2e,
              run_in_background: true,
            },
            'Command running in background with ID: b9t3y5u. Output is being written to: tasks/b9t3y5u.output.',
            'fixer',
          ),
          delay(BEAT_MS * 4),
          taskEnd('fixer-lint', SUBAGENT_BACKGROUND_WORK.lintDone),
          say(SUBAGENT_BACKGROUND_WORK.waiting, 'fixer'),
          // Until it's stopped.
          delay(10 * 60_000),
        ],
        { summary: 'Fixed the flaky checkout test: the retry waited on the wrong request.' },
      ),
      say(SUBAGENT_BACKGROUND_WORK.started),
      result(),
    ],
    [...turnStart(), delay(BEAT_MS), say(SUBAGENT_BACKGROUND_WORK.again), result()],
  ],
}

/** A wake's turn: the agent says one thing and ends it. */
const wakeReply = (text: string): ScriptStep[] => [...turnStart(), delay(BEAT_MS), say(text), result()]

/**
 * Leaves one of each watcher running or scheduled (`docs/sdk-notes.md` §13), as an agent asked to watch several things
 * would: a `Monitor` on the PR's CI checks, two commands in the background, a `ScheduleWakeup` and a recurring
 * `CronCreate` job. Then they wake it, a turn each: a failed check, the docs build failing, the job firing and a
 * passing check. The monitor and the tests keep running, and the wakeup and the job stay scheduled, until something
 * stops them. Resumed, the session has the job back, as the SDK restores it.
 */
const watchesThings: AgentScript = {
  name: 'watches-things',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      ...describeTask(
        WATCHES_THINGS.title,
        'Watch the CI checks on PR #42 and report what fails; keep an eye on the docs and the staging queue.',
        'Watching the CI checks on PR #42.',
      ),
      ...tool(
        'ci',
        'Monitor',
        { description: WATCHES_THINGS.ci, timeout_ms: 1_800_000, command: WATCHES_THINGS.ciCommand },
        'Monitor started (task bm7c2x1, expires in 30m unless the source ends first; you get one notice at expiry — ' +
          're-arm if you still need the watch). You will be notified on each event.',
      ),
      ...tool(
        'tests',
        'Bash',
        { command: WATCHES_THINGS.testsCommand, description: WATCHES_THINGS.tests, run_in_background: true },
        'Command running in background with ID: b4k2p9x. Output is being written to: tasks/b4k2p9x.output.',
      ),
      ...tool(
        'docs',
        'Bash',
        { command: WATCHES_THINGS.docsCommand, description: WATCHES_THINGS.docs, run_in_background: true },
        'Command running in background with ID: b8d3q1z. Output is being written to: tasks/b8d3q1z.output.',
      ),
      ...tool(
        'rollout',
        'ScheduleWakeup',
        { delaySeconds: 300, reason: WATCHES_THINGS.rollout, prompt: WATCHES_THINGS.rolloutPrompt, noop: false },
        'Next wakeup scheduled (in 300s). Nothing more to do this turn — the harness re-invokes you when the wakeup ' +
          'fires or a task-notification arrives.',
      ),
      toolUse('queue', 'CronCreate', { cron: WATCHES_THINGS.queueCron, prompt: WATCHES_THINGS.queue, recurring: true }),
      toolResult(
        'queue',
        `Scheduled recurring job ${WATCHES_THINGS.queueJob} (${WATCHES_THINGS.queueSchedule}). Session-only (not ` +
          'written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner.',
        false,
        { id: WATCHES_THINGS.queueJob, humanSchedule: WATCHES_THINGS.queueSchedule },
      ),
      wake(wakeReply(WATCHES_THINGS.checkFailed), {
        cause: WakeCause.MonitorEvent,
        task: 'ci',
        event: WATCHES_THINGS.ciFailed,
        ms: BEAT_MS * 6,
      }),
      wake(wakeReply(WATCHES_THINGS.docsBuildFailed), {
        task: 'docs',
        outcome: 'failed',
        summary: WATCHES_THINGS.docsFailed,
        ms: BEAT_MS * 10,
      }),
      wake(wakeReply(WATCHES_THINGS.queueChecked), { cause: WakeCause.Scheduled, job: 'queue', ms: BEAT_MS * 14 }),
      wake(wakeReply(WATCHES_THINGS.lintPassed), {
        cause: WakeCause.MonitorEvent,
        task: 'ci',
        event: WATCHES_THINGS.ciPassed,
        ms: BEAT_MS * 18,
      }),
      say(WATCHES_THINGS.started),
      result(),
    ],
    wakeReply(WATCHES_THINGS.again),
  ],
  restoredJobs: [
    { id: WATCHES_THINGS.queueJob, schedule: WATCHES_THINGS.queueCron, recurring: true, prompt: WATCHES_THINGS.queue },
  ],
}

/**
 * The `watches-things` task after a relaunch: its session, resumed by your next message, has the cron job back, as the
 * SDK restores it, and the agent answers without starting anything new.
 */
const stillWatching: AgentScript = {
  name: 'still-watching',
  turns: [wakeReply(WATCHES_THINGS.again)],
  restoredJobs: watchesThings.restoredJobs,
}

/** What the `drives-glade` script's agent does to Glade through its control tools, and says. */
export const DRIVES_GLADE = {
  /** What the user asks it. */
  prompt: 'Set up the release tasks.',
  /** The seeded workspace (`e2e/seeds/control.json`). */
  workspaceId: '0b6f7c2e-5a41-4d3e-9c8a-1f2e3d4c5b6a',
  /** The task it makes, and the first message it sends it. */
  created: { title: 'Draft the release notes', message: 'Draft the release notes for 2.4.' },
  /** The seeded task it renames, gives a status and marks done. */
  target: {
    id: '7d9e8f10-2b3c-4a5d-8e6f-0a1b2c3d4e5f',
    title: 'Tidy the changelog for 2.4',
    status: 'The changelog for 2.4 is tidy.',
  },
  reply: 'I made "Draft the release notes" and started it, and marked the changelog task done.',
} as const

/**
 * A turn that drives Glade through its control tools (`glade-control`): it lists the workspace's tasks, creates one
 * with a first message (which starts it), renames another and gives it a status, then marks it done. In the ask mode
 * the reads go ahead and each change waits on a permission card. The session needs the control tools: seed Settings'
 * `controlEnabled`.
 */
const drivesGlade: AgentScript = {
  name: 'drives-glade',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      say("I'll look at the workspace's tasks, then set up the release work."),
      controlTool('list', 'list_tasks', { workspaceId: DRIVES_GLADE.workspaceId }),
      controlTool('create', 'create_task', {
        workspaceId: DRIVES_GLADE.workspaceId,
        title: DRIVES_GLADE.created.title,
        message: DRIVES_GLADE.created.message,
      }),
      controlTool('update', 'update_task', {
        id: DRIVES_GLADE.target.id,
        patch: { title: DRIVES_GLADE.target.title, status: DRIVES_GLADE.target.status },
      }),
      controlTool('done', 'mark_done', { id: DRIVES_GLADE.target.id }),
      say(DRIVES_GLADE.reply),
      result(),
    ],
  ],
}

/** What the `replies-briefly` script's agent says. */
export const REPLIES_BRIEFLY = { reply: 'Here is a first draft of the release notes.' } as const

/** A turn that only replies: no title, objective or status of its own, so what made the task keeps them. */
const repliesBriefly: AgentScript = {
  name: 'replies-briefly',
  turns: [[...turnStart(), delay(BEAT_MS), say(REPLIES_BRIEFLY.reply), result()]],
}

/** What the `ports-sessions` script's agent imports from Claude Code, and says. */
export const PORTS_SESSIONS = {
  /** What the user asks it. */
  prompt: 'Port my Claude Code session in.',
  /** The invented session it imports (`e2e/import-sessions.spec.ts` writes its transcript). */
  sessionId: '5b2f8c1e-4d7a-4e3b-9f10-2a6c8d9e0f11',
  reply: 'I imported your Claude Code session about the rate limit tests. It is under Done.',
} as const

/**
 * A turn that ports a Claude Code session into Glade through the control tools (`glade-control`): it lists the
 * sessions not yet in Glade, then imports the one, adding its folder as a workspace, and says so.
 */
const portsSessions: AgentScript = {
  name: 'ports-sessions',
  turns: [
    [
      ...turnStart(),
      say("I'll look for sessions that aren't in Glade yet."),
      controlTool('list', 'list_claude_code_sessions', { imported: false }),
      controlTool('import', 'import_claude_code_session', {
        sessionId: PORTS_SESSIONS.sessionId,
        createWorkspace: true,
      }),
      say(PORTS_SESSIONS.reply),
      result(),
    ],
  ],
}

/** One past task the `backfills-tasks` script backfills, from its notes folder in the workspace. */
export interface BackfilledTaskSample {
  readonly externalId: string
  readonly title: string
  readonly objective: string
  readonly handoff: string
  readonly startedAt: string
  /** Its notes, relative to the workspace root: the script registers them as its artifacts, by absolute path. */
  readonly artifacts: readonly { readonly path: string; readonly title: string }[]
}

/** What the `backfills-tasks` script's agent backfills, from notes folders in its workspace, and says. */
export const BACKFILLS_TASKS = {
  /** What the user asks it. */
  prompt: 'Backfill my past billing tasks from their notes.',
  /** The workspace the tasks go in, which a spec seeds with this id. */
  workspaceId: '5c2d8e1a-7b4f-4c3a-9d6e-2f1a0b9c8d7e',
  tasks: [
    {
      externalId: 'notes/billing-webhooks',
      title: 'Migrate billing webhooks to v2',
      objective: 'Move the billing webhook handlers from the v1 events API to v2, then retire the v1 endpoint.',
      handoff: [
        '### Where it got to',
        '',
        'The `invoice.*` and `customer.*` handlers are on v2 and live. `subscription.*` still goes through v1.',
        '',
        '### Next',
        '',
        'Write the `subscription.*` mapping, then turn v1 off. Notes are in `notes/billing-webhooks/`.',
      ].join('\n'),
      startedAt: '2026-03-12T09:00:00Z',
      artifacts: [
        { path: 'notes/billing-webhooks/notes.md', title: 'Migration notes' },
        { path: 'notes/billing-webhooks/decisions.md', title: 'Decisions' },
      ],
    },
    {
      externalId: 'notes/invoice-pdfs',
      title: 'Render invoice PDFs on the server',
      objective: 'Render invoice PDFs on the server instead of in the browser.',
      handoff: '### Where it got to\n\nThe renderer works. Fonts still need embedding; see `notes/invoice-pdfs/`.',
      startedAt: '2026-04-02',
      artifacts: [{ path: 'notes/invoice-pdfs/notes.md', title: 'PDF notes' }],
    },
  ] satisfies readonly BackfilledTaskSample[],
  reply: 'I backfilled your two billing tasks from their notes.',
  /** What it says when it's asked again and finds them already there. */
  again: 'Both billing tasks were already backfilled, so nothing changed.',
} as const

/** A turn that backfills the `BACKFILLS_TASKS` tasks through the control tools, each done, then says `reply`. */
const backfillTurn = (reply: string, run: number): ScriptStep[] => [
  ...turnStart(),
  delay(BEAT_MS),
  say("I'll backfill each notes folder as a done task, with its handoff note and notes."),
  ...BACKFILLS_TASKS.tasks.flatMap(({ artifacts, ...task }, index) => [
    controlTool(`backfill-${String(run)}-${String(index)}`, 'create_task', (cwd) => ({
      workspaceId: BACKFILLS_TASKS.workspaceId,
      ...task,
      state: 'done',
      artifacts: artifacts.map(({ path, title }) => ({ path: `${cwd}/${path}`, title })),
    })),
  ]),
  say(reply),
  result(),
]

/**
 * Backfills past tasks through the control tools (`glade-control`): a done task per notes folder, each with its handoff
 * note, its notes as artifacts, when it started and its folder as its `externalId`. Asked again, it runs the same calls,
 * which find the tasks already there and create nothing. The session needs the control tools, and a workspace with the
 * `BACKFILLS_TASKS` id whose root holds the notes: seed both.
 */
const backfillsTasks: AgentScript = {
  name: 'backfills-tasks',
  turns: [backfillTurn(BACKFILLS_TASKS.reply, 1), backfillTurn(BACKFILLS_TASKS.again, 2)],
}

/**
 * What the `makes-commits` and `makes-another-commit` scripts' agents commit, for the Changes tab's specs and
 * screenshots: in the workspace's repository (`setup` makes it, as a person's existing one, when it isn't one yet) and,
 * through a subagent, in a worktree beside it.
 */
export const MAKES_COMMITS = {
  prompt: 'The date formatting test fails in some timezones. Fix it, bump the version, and update the upgrade guide.',
  title: 'Fix the UTC date test',
  /** Makes the workspace a repository with a first commit of a person's, and a release script that commits. */
  setup: [
    'git init -q -b main',
    'mkdir -p src docs scripts',
    "printf 'export const header = (d) => `Report for ${d.toString()}`\\n' > src/date.ts",
    'printf \'{ "name": "acme-api", "version": "2.4.0" }\\n\' > package.json',
    "printf '# Upgrading\\n\\nRead the release notes first: they list every change that breaks a client.\\n\\n" +
      "Back up the database before you upgrade.\\n\\nUpgrade the workers before the web servers.\\n' > docs/upgrade.md",
    "printf '#!/bin/sh\\nsed -i.bak s/2.4.0/2.4.1/ package.json && rm package.json.bak\\n" +
      'git commit -qam "Bump the version" > /dev/null\\n\' > scripts/release.sh',
    'chmod +x scripts/release.sh',
    'git add -A',
    'git commit -q -m "Start the Acme API"',
  ].join(' && '),
  fix: 'Fix the UTC date test',
  fixCommand:
    "printf 'export const header = (d: Date) => `Report for ${d.toISOString().slice(0, 10)}`\\n' > src/date.ts" +
    ' && git add src/date.ts && git commit -m "Fix the UTC date test"',
  /** The release script commits, silently: only `HEAD` moving says so. */
  releaseCommand: './scripts/release.sh',
  bump: 'Bump the version to 2.4.1',
  amendCommand: 'git commit --amend -q -m "Bump the version to 2.4.1"',
  /** The worktree the subagent works in, beside the workspace. */
  worktree: '../acme-api-docs',
  worktreeBranch: 'docs/upgrade',
  worktreeCommand: 'git worktree add -q -b docs/upgrade ../acme-api-docs',
  subagent: 'Update the upgrade guide',
  guide: 'Rename the upgrade guide and add the logo',
  guideCommand:
    "git mv docs/upgrade.md docs/upgrading.md && printf '\\nRun the migrations before you start the server.\\n' >> " +
    "docs/upgrading.md && printf '\\211PNG\\r\\n\\032\\n\\000\\000' > docs/logo.png && git add -A && " +
    'git commit -m "Rename the upgrade guide and add the logo"',
  merge: 'Merge the upgrade guide',
  mergeCommand: 'git merge --no-ff -q -m "Merge the upgrade guide" docs/upgrade',
  reply:
    'Fixed the UTC date test (it built its date in local time), bumped the version to 2.4.1, and merged the renamed ' +
    'upgrade guide. The commits are in the Changes tab.',
  /** The other task's. */
  otherPrompt: 'Tidy the README.',
  otherTitle: 'Tidy the README',
  other: 'Tidy the README',
  otherCommand:
    'printf \'# Acme API\\n\\nThe public API.\\n\' > README.md && git add README.md && git commit -m "Tidy the README"',
  otherReply: 'Tidied the README.',
} as const

/**
 * Makes real commits in the workspace's repository (`docs/sdk-notes.md` §14), each a way the Changes tab has to see:
 * a `git commit` that prints its hash, the release script committing silently, an amend of that commit, a subagent
 * committing a rename and a binary file in a worktree of its own, and a merge commit of its branch.
 */
const makesCommits: AgentScript = {
  name: 'makes-commits',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      ...describeTask(
        MAKES_COMMITS.title,
        'Fix the date formatting test that fails in some timezones, bump the version and update the upgrade guide.',
        'Fixing the UTC date test.',
      ),
      shell('setup', `test -d .git || { ${MAKES_COMMITS.setup}; }`, 'Make the workspace a repository if it isn’t one'),
      say('The test builds its date in local time. Fixing it to use UTC.'),
      shell('fix', MAKES_COMMITS.fixCommand, 'Fix the date test and commit it'),
      delay(BEAT_MS),
      shell('release', MAKES_COMMITS.releaseCommand, 'Bump the version with the release script'),
      shell('amend', MAKES_COMMITS.amendCommand, 'Say which version in the commit message'),
      delay(BEAT_MS),
      shell('worktree', MAKES_COMMITS.worktreeCommand, 'Make a worktree for the upgrade guide'),
      toolUse('docs', 'Agent', {
        description: MAKES_COMMITS.subagent,
        subagent_type: 'general-purpose',
        prompt: `In ${MAKES_COMMITS.worktree}, rename docs/upgrade.md to docs/upgrading.md, add the migrations step and the logo, and commit.`,
      }),
      say('Renaming the guide and adding the logo.', 'docs'),
      shell('guide', MAKES_COMMITS.guideCommand, 'Rename the guide, add the logo and commit', {
        cwd: MAKES_COMMITS.worktree,
        parent: 'docs',
      }),
      toolResult('docs', 'Renamed the upgrade guide, added the migrations step and the logo, and committed.'),
      delay(BEAT_MS),
      shell('merge', MAKES_COMMITS.mergeCommand, 'Merge the upgrade guide'),
      say(MAKES_COMMITS.reply),
      result(),
    ],
  ],
}

/** Makes one commit in the workspace's repository: another task's, in the same repository as `makes-commits`. */
const makesAnotherCommit: AgentScript = {
  name: 'makes-another-commit',
  turns: [
    [
      ...turnStart(),
      delay(BEAT_MS),
      ...describeTask(MAKES_COMMITS.otherTitle, 'Tidy the README.', 'Tidying the README.'),
      shell('readme', MAKES_COMMITS.otherCommand, 'Tidy the README and commit it'),
      say(MAKES_COMMITS.otherReply),
      result(),
    ],
  ],
}

/** The names a spec can ask for. */
export const AGENT_SCRIPT_NAMES = [
  'makes-commits',
  'makes-another-commit',
  'simple-reply',
  'multi-tool-turn',
  'long-running',
  'long-build',
  'failing-turn',
  'fails-to-start',
  'flaky-api',
  'copy-in-batches',
  'long-context',
  'auto-compaction',
  'asks-a-question',
  'asks-many-choices',
  'parallel-subagents',
  'shows-a-file',
  'declares-artifacts',
  'usage-limit',
  'usage-limit-hour',
  'usage-warning',
  'usage-warning-resets',
  'usage-warning-then-limit',
  'offline',
  'keeps-todos',
  'writes-todos',
  'finishes-in-background',
  'background-subagents',
  'stop-spares-background',
  'subagent-calls',
  'asks-permission',
  'asks-permission-from-a-subagent',
  'allows-for-task',
  'permission-at-quit',
  'watches-ci',
  'checks-back-later',
  'scheduled-check',
  'watches-things',
  'still-watching',
  'drives-glade',
  'replies-briefly',
  'ports-sessions',
  'backfills-tasks',
  'subagent-background-work',
] as const

export type AgentScriptName = (typeof AGENT_SCRIPT_NAMES)[number]

/** Every script a test mode can run, by name. */
export const AGENT_SCRIPTS: Readonly<Record<AgentScriptName, AgentScript>> = {
  'makes-commits': makesCommits,
  'makes-another-commit': makesAnotherCommit,
  'simple-reply': simpleReply,
  'multi-tool-turn': multiToolTurn,
  'long-running': longRunning,
  'long-build': longBuild,
  'failing-turn': failingTurn,
  'fails-to-start': failsToStart,
  'flaky-api': flakyApi,
  'copy-in-batches': copyInBatches,
  'long-context': longContext,
  'auto-compaction': autoCompaction,
  'asks-a-question': asksAQuestion,
  'asks-many-choices': asksManyChoices,
  'parallel-subagents': parallelSubagents,
  'shows-a-file': showsAFile,
  'declares-artifacts': declaresArtifacts,
  'usage-limit': usageLimit,
  'usage-limit-hour': usageLimitHour,
  'usage-warning': usageWarning,
  'usage-warning-resets': usageWarningResets,
  'usage-warning-then-limit': usageWarningThenLimit,
  offline,
  'keeps-todos': keepsTodos,
  'writes-todos': writesTodos,
  'finishes-in-background': finishesInBackground,
  'background-subagents': backgroundSubagents,
  'stop-spares-background': stopSparesBackground,
  'subagent-calls': subagentCalls,
  'asks-permission': asksPermission,
  'asks-permission-from-a-subagent': asksPermissionFromASubagent,
  'allows-for-task': allowsForTask,
  'permission-at-quit': permissionAtQuit,
  'watches-ci': watchesCi,
  'checks-back-later': checksBackLater,
  'scheduled-check': scheduledCheck,
  'watches-things': watchesThings,
  'still-watching': stillWatching,
  'drives-glade': drivesGlade,
  'replies-briefly': repliesBriefly,
  'ports-sessions': portsSessions,
  'backfills-tasks': backfillsTasks,
  'subagent-background-work': subagentBackgroundWork,
}
