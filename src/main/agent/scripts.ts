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
   * The agent starts a turn of its own once the turn it's in has ended, as the SDK does when a background command or
   * subagent finishes, or a timer or scheduled wakeup fires (`docs/sdk-notes.md`, "Turns the agent starts itself"):
   * `ms` after this step (no time by default), and once no turn is playing, the session streams the `task_updated` and
   * `task_notification` for the task that finished, then plays `turn` with no user message behind it. Its assistant
   * messages carry no `user_message_uuid`, and its `result` no `user_message_uuids` but `origin: task-notification`.
   * A message sent while it plays is folded into it, as into any turn.
   */
  Wake = 'wake',
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
  readonly questions: readonly Question[]
}

export interface LimitReachedStep {
  readonly kind: ScriptStepKind.LimitReached
  /** How long from now the limit resets. */
  readonly resetInMs: number
}

export interface WakeStep {
  readonly kind: ScriptStepKind.Wake
  /** How long after this step the agent wakes, in milliseconds: no time by default. */
  readonly ms?: number
  /** The script id of the tool call, in this turn, whose background task finished; none for a timer or wakeup. */
  readonly task?: string
  /** What the task notification says finished. */
  readonly summary: string
  /** What the agent does in the turn it starts. */
  readonly turn: ScriptTurn
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
}

export type ScriptStep =
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
  | WakeStep
  | BackgroundStep
  | PermissionStep

export type ScriptTurn = readonly ScriptStep[]

export interface AgentScript {
  readonly name: string
  /** At least one. */
  readonly turns: readonly ScriptTurn[]
  /**
   * What the agent does when Glade resumes its session to carry on a turn the app quit in: on launch (the runner's
   * `RESUME_PROMPT`), or once you answer a question the app quit on (its `answeredAfterRestart` message). Without one,
   * that message runs the next turn like any other.
   */
  readonly resumeTurn?: ScriptTurn
  /**
   * What the agent does when Glade sends it `/compact` (the runner's `COMPACT_COMMAND`). By default it compacts, as
   * `DEFAULT_COMPACT_TURN` does. It isn't one of `turns`: the message after it runs the next of those.
   */
  readonly compactTurn?: ScriptTurn
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

export const toolResult = (id: string, output: string, isError = false): ToolResultStep => ({
  kind: ScriptStepKind.ToolResult,
  id,
  output,
  isError,
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

export const result = (options: Omit<ResultStep, 'kind'> = {}): ResultStep => ({
  kind: ScriptStepKind.Result,
  ...options,
})

export const emit = (message: unknown): EmitStep => ({ kind: ScriptStepKind.Emit, message })

export const delay = (ms: number): DelayStep => ({ kind: ScriptStepKind.Delay, ms })

export const fail = (message: string): FailStep => ({ kind: ScriptStepKind.Fail, message })

export const waitForInterrupt = (): WaitForInterruptStep => ({ kind: ScriptStepKind.WaitForInterrupt })

export const fillContext = (fraction: number): FillContextStep => ({ kind: ScriptStepKind.FillContext, fraction })

export const compact = (options: Omit<CompactStep, 'kind'> = {}): CompactStep => ({
  kind: ScriptStepKind.Compact,
  ...options,
})

export const ask = (id: string, questions: readonly Question[]): AskStep => ({
  kind: ScriptStepKind.Ask,
  id,
  questions,
})

export const limitReached = (resetInMs: number): LimitReachedStep => ({
  kind: ScriptStepKind.LimitReached,
  resetInMs,
})

export const wake = (turn: ScriptTurn, options: Omit<WakeStep, 'kind' | 'turn'>): WakeStep => ({
  kind: ScriptStepKind.Wake,
  turn,
  ...options,
})

export const background = (
  id: string,
  input: ToolInput,
  steps: ScriptTurn,
  options: Omit<BackgroundStep, 'kind' | 'id' | 'input' | 'steps'>,
): BackgroundStep => ({ kind: ScriptStepKind.Background, id, input, steps, ...options })

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
const usageLimitReached = (resetInMs: number): ScriptStep[] => [
  limitReached(resetInMs),
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
      // Said just before asking, so the question card leads with it.
      say('41 PRs since v2.3.0. A few choices are yours before I draft the notes.'),
      ask('questions', RELEASE_NOTES_QUESTIONS),
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

/**
 * Three subagents run side by side, splitting the release notes by area: one checks the links in the last notes and
 * finishes, while the other two keep reading PRs (one last said something, the other is in a tool call) until the turn
 * is stopped, so a spec can watch them run, then see them fail when it stops them.
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
      ...tool(
        'links-fix',
        'Edit',
        { file_path: 'docs/releases/2.3.md', old_string: '/docs/limits', new_string: '/docs/rate-limits' },
        'The file docs/releases/2.3.md has been updated.',
        'links',
      ),
      toolResult('links', 'Found 2 broken links and fixed both in the draft.'),
      ...tool(
        'api-view',
        'Bash',
        { command: 'gh pr view 1402 --json title,body', description: 'Read PR 1402' },
        '{"title":"Rate limit the public API"}',
        'api',
      ),
      say('#1418 moves the charts onto the new query, so it belongs under features, not fixes.', 'dashboard'),
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

/** The names a spec can ask for. */
export const AGENT_SCRIPT_NAMES = [
  'simple-reply',
  'multi-tool-turn',
  'long-running',
  'long-build',
  'failing-turn',
  'flaky-api',
  'copy-in-batches',
  'long-context',
  'auto-compaction',
  'asks-a-question',
  'parallel-subagents',
  'shows-a-file',
  'declares-artifacts',
  'usage-limit',
  'usage-limit-hour',
  'offline',
  'keeps-todos',
  'writes-todos',
  'finishes-in-background',
  'background-subagents',
  'asks-permission',
] as const

export type AgentScriptName = (typeof AGENT_SCRIPT_NAMES)[number]

/** Every script a test mode can run, by name. */
export const AGENT_SCRIPTS: Readonly<Record<AgentScriptName, AgentScript>> = {
  'simple-reply': simpleReply,
  'multi-tool-turn': multiToolTurn,
  'long-running': longRunning,
  'long-build': longBuild,
  'failing-turn': failingTurn,
  'flaky-api': flakyApi,
  'copy-in-batches': copyInBatches,
  'long-context': longContext,
  'auto-compaction': autoCompaction,
  'asks-a-question': asksAQuestion,
  'parallel-subagents': parallelSubagents,
  'shows-a-file': showsAFile,
  'declares-artifacts': declaresArtifacts,
  'usage-limit': usageLimit,
  'usage-limit-hour': usageLimitHour,
  offline,
  'keeps-todos': keepsTodos,
  'writes-todos': writesTodos,
  'finishes-in-background': finishesInBackground,
  'background-subagents': backgroundSubagents,
  'asks-permission': asksPermission,
}
