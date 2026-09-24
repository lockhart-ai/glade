/**
 * Agent scripts: what the test modes' fake agent does, turn by turn, in place of a model. A script is plain typed data,
 * named, with a list of turns; each user message runs the next turn (a message past the last turn runs the last turn
 * again). A turn is a list of steps, which `./scripted-session` plays into realistic SDK messages (shapes from
 * `docs/sdk-notes.md` §2), so the app handles them exactly as it would a real run.
 *
 * The e2e and capture specs pick a script from `AGENT_SCRIPTS` by name, e.g. `agentScript: 'multi-tool-turn'`.
 */
import type { ToolInput } from '../../shared/domain'

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
   * The account's usage limit runs out: a `rate_limit_event` saying it's rejecting requests until `resetInMs` from now
   * (to the second, as the SDK gives it), as the SDK sends when a request hits the limit.
   */
  LimitReached = 'limit_reached',
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

export interface LimitReachedStep {
  readonly kind: ScriptStepKind.LimitReached
  /** How long from now the limit resets. */
  readonly resetInMs: number
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
  | LimitReachedStep

export type ScriptTurn = readonly ScriptStep[]

export interface AgentScript {
  readonly name: string
  /** At least one. */
  readonly turns: readonly ScriptTurn[]
  /**
   * What the agent does when Glade resumes its session on launch to carry on a turn the app quit in (the runner's
   * `RESUME_PROMPT`). Without one, that message runs the next turn like any other.
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

export const limitReached = (resetInMs: number): LimitReachedStep => ({
  kind: ScriptStepKind.LimitReached,
  resetInMs,
})

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
      emit({
        type: 'system',
        subtype: 'task_started',
        task_type: 'local_agent',
        subagent_type: 'Explore',
        description: 'Find flaky tests',
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
  'usage-limit',
  'usage-limit-hour',
  'offline',
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
  'usage-limit': usageLimit,
  'usage-limit-hour': usageLimitHour,
  offline,
}
