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
  'failing-turn',
  'flaky-api',
  'copy-in-batches',
] as const

export type AgentScriptName = (typeof AGENT_SCRIPT_NAMES)[number]

/** Every script a test mode can run, by name. */
export const AGENT_SCRIPTS: Readonly<Record<AgentScriptName, AgentScript>> = {
  'simple-reply': simpleReply,
  'multi-tool-turn': multiToolTurn,
  'long-running': longRunning,
  'failing-turn': failingTurn,
  'flaky-api': flakyApi,
  'copy-in-batches': copyInBatches,
}
