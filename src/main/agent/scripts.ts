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

/** A turn that fails on an API error after it has started working. */
const failingTurn: AgentScript = {
  name: 'failing-turn',
  turns: [
    [
      ...turnStart(),
      say("I'll check the build first."),
      ...tool('build', 'Bash', { command: 'npm run build', description: 'Build the app' }, 'Built in 2.1s'),
      delay(BEAT_MS),
      result({
        text: '',
        isError: true,
        terminalReason: 'api_error',
        errors: ['API Error: 529 Overloaded. Try again in a moment.'],
        extra: { api_error_status: 529 },
      }),
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
  'long-build',
  'failing-turn',
  'copy-in-batches',
  'long-context',
] as const

export type AgentScriptName = (typeof AGENT_SCRIPT_NAMES)[number]

/** Every script a test mode can run, by name. */
export const AGENT_SCRIPTS: Readonly<Record<AgentScriptName, AgentScript>> = {
  'simple-reply': simpleReply,
  'multi-tool-turn': multiToolTurn,
  'long-running': longRunning,
  'long-build': longBuild,
  'failing-turn': failingTurn,
  'copy-in-batches': copyInBatches,
  'long-context': longContext,
}
