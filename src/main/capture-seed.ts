/**
 * Sample data for screenshots and e2e specs: `npm run screenshot -- --seed <fixture>` (or an e2e spec's `seed`) fills
 * the throwaway database from a JSON fixture before the window opens, so a capture or a spec can show a populated app.
 * Only the test modes use it.
 */
import { existsSync, readFileSync, utimesSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Database } from 'better-sqlite3'
import { z } from 'zod'
import {
  AgentErrorKind,
  ArtifactFilter,
  AutoCompactKind,
  CompactionTrigger,
  DividerKind,
  Effort,
  MessageRole,
  PauseReason,
  PermissionDestination,
  PermissionMode,
  PermissionRequestState,
  PermissionRuleBehavior,
  PermissionUpdateType,
  TaskActivity,
  TaskErrorSource,
  TaskState,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  WatcherKind,
  WatcherState,
  type AutoCompact,
  type EpochMs,
  type PermissionSuggestion,
  type Question,
  type TaskError,
  type ToolInput,
  type TurnSummary,
  type PermissionMarkOutcome,
} from '../shared/domain'
import { taskPermissionRule } from '../shared/permissions'
import type { ReportedMcpServer } from '../shared/mcpServers'
import type { CardGrantScope, SandboxAsk } from '../shared/sandbox'
import { permissionMarkOutcomeSchema, sandboxAskSchema } from './permissions/schema'
import { setPermissionMark } from './db/repositories/permission-marks'
import { preambleSchema, questionsSchema } from './questions/schema'
import { appendQuestionSet } from './db/repositories/question-sets'
import { serializeRelaunchNotice } from '../shared/relaunchNotice'
import { addArtifact, addLinkArtifact, setArtifactFile, setArtifactFilter } from './db/repositories/artifacts'
import { standInForWorkspaceRoot, workspaceFilesRoot } from './files/files'
import { setHandoff } from './db/repositories/backfills'
import { appendMessage } from './db/repositories/messages'
import {
  appendPermissionRequest,
  closePermissionRequest,
  type PermissionRequestClosing,
} from './db/repositories/permission-requests'
import { setOpenFiles } from './db/repositories/open-files'
import { setBrowseFolderExpanded } from './db/repositories/browse-folders'
import { appendQueuedMessage } from './db/repositories/queued-messages'
import { addTaskPermissionRule } from './db/repositories/task-permission-rules'
import { createTask, updateTask } from './db/repositories/tasks'
import { setSdkModels } from './db/repositories/sdk-models'
import type { ModelChoice } from '../shared/models'
import {
  appendCompaction,
  appendDivider,
  appendNarration,
  appendToolCall,
  setSubagentProgress,
  updateToolCall,
} from './db/repositories/tool-events'
import { setUiState } from './db/repositories/ui-state'
import { addWatcher, updateWatcher } from './db/repositories/watchers'
import { addTaskCommit, CommitSource } from './db/repositories/task-commits'
import { setTodoPanel } from './db/repositories/todo-panels'
import { createWorkspace, getWorkspaceByRoot } from './db/repositories/workspaces'
import { recordNotification } from './db/repositories/notifications'
import { setSessionContext } from './db/repositories/session-context'
import { INSTRUCTION_UPDATES } from './agent/system-prompt'
import { DEFAULT_SETTINGS, type SettingsPatch } from '../shared/settings'
import { SETTING_SCHEMAS, updateSettings } from './db/repositories/settings'
import { replaceUsageReadings, saveAccount } from './db/repositories/account'
import { usageLevel, UsageLevel, UsageLimitKind, type ExtraUsageStatus, type UsageLimit } from '../shared/account'
import { storeControlToken, storedToken } from './control/token'
import { noteReportedServers } from './db/repositories/reported-mcp-servers'
import { addSandboxGrant } from './db/repositories/sandbox-grants'
import {
  FolderAccess,
  OtherAgents,
  SandboxGrantKind,
  SandboxGrantScope,
  type Grant,
  type SandboxGrantTarget,
} from '../shared/sandbox'
import { refreshTodos } from './todos/todos'
import { fileChildren } from './todo-hub/todo-hub'
import {
  ChildFilter,
  ChildKind,
  childOfArtifact,
  childOfCommit,
  FilingSource,
  type ChildRef,
  type NewFiling,
} from '../shared/todoHub'

const MINUTE = 60_000

/** One sample chat message. */
export interface SeedMessage {
  readonly role: MessageRole
  /** Markdown. */
  readonly body: string
  readonly turn: number
  /** How long before the capture it was sent. */
  readonly minutesAgo: number
  /** An agent reply's turn summary; none unless given. */
  readonly summary?: TurnSummary | undefined
  /** Whether you sent it with Broadcast (#489), so the chat tags it; not unless given. */
  readonly broadcast?: boolean | undefined
}

/** A sample note from the agent in the tool log. */
export interface SeedNarration {
  readonly kind: ToolEventKind.Narration
  readonly text: string
  /** The `toolUseId` of the `Agent` call whose subagent wrote it; the agent's own note when not given. */
  readonly parentToolUseId?: string | undefined
  readonly turn: number
  readonly minutesAgo: number
}

/** A sample tool call. It's still running unless it has an output, and done with it unless it has another `state`. */
export interface SeedToolCall {
  readonly kind: ToolEventKind.ToolCall
  readonly name: string
  readonly input: ToolInput
  readonly output?: string | undefined
  /** How the call ended, with its output: done unless given (e.g. `error`, when its output is the error). */
  readonly state?: FinishedToolCallState | undefined
  /** Its `tool_use` id, for a subagent's calls to name as their parent; generated when not given. */
  readonly toolUseId?: string | undefined
  /** The `toolUseId` of the `Agent` call whose subagent made this call; top level when not given. */
  readonly parentToolUseId?: string | undefined
  readonly turn: number
  readonly minutesAgo: number
  /** How long before the capture its result arrived, when it has one; `minutesAgo` unless given. */
  readonly finishedMinutesAgo?: number | undefined
  /** What a running `Agent` call's subagent says it's doing now (its progress summary); none unless given. */
  readonly progressSummary?: string | undefined
  /** For an `Agent` call: the todo its subagent is filed under in the hub (`SeedTodoId`); none unless given. */
  readonly todo?: SeedTodoId | undefined
}

/**
 * The todo a sample child is filed under in the todo hub (P16; `../shared/todoHub`), by the id Claude Code gave it:
 * the `N` of the `Task #N` its sample `TaskCreate` call answers with. Filed as main files any child (`fileChildren`),
 * so it needs the hub on (`settings.todoHubEnabled`); with it off, nothing is filed.
 */
export type SeedTodoId = string

/** A sample divider in the tool log. */
export interface SeedDivider {
  readonly kind: ToolEventKind.Divider
  readonly dividerKind: DividerKind
  readonly turn: number
  readonly minutesAgo: number
}

/** A sample compaction (`CompactionEvent`), done unless it has another `state`. */
export interface SeedCompaction {
  readonly kind: ToolEventKind.Compaction
  readonly trigger: CompactionTrigger
  readonly state?: ToolCallState | undefined
  readonly preTokens: number | null
  readonly postTokens: number | null
  readonly windowTokens: number
  /** What it carried over; none unless given. */
  readonly summary?: string | undefined
  readonly turn: number
  readonly minutesAgo: number
}

/**
 * A sample permission request (`PermissionRequest`): a tool call waiting on your OK, or that waited on it, open unless
 * it has another `state`.
 */
export interface SeedPermissionRequest {
  readonly toolName: string
  readonly input: ToolInput
  /** The call's `tool_use` id, which its tool log row has too (a subagent's names its `Agent` call as its parent). */
  readonly toolUseId: string
  /** The SDK's id for the subagent that made the call; the agent's own call when not given. */
  readonly agentId?: string | undefined
  readonly title?: string | undefined
  readonly description?: string | undefined
  readonly defaultToNo?: boolean | undefined
  /** The rule content Claude Code suggests for the call's tool (e.g. `npm test *` for `Bash`); none by default. */
  readonly suggestedRule?: string | undefined
  readonly state?: PermissionRequestState | undefined
  /** The note it was denied with. */
  readonly denyNote?: string | undefined
  /** Whether it was allowed for the task (Allow for this task), which grants the task its rule; allowed once if not. */
  readonly forTask?: boolean | undefined
  /** What it asks of the agent sandbox (the sandbox's cards, #450); nothing unless given. */
  readonly sandbox?: SandboxAsk | undefined
  /** Who a folder or domain it was allowed was granted to: the task, or its workspace. */
  readonly grantedScope?: CardGrantScope | undefined
  readonly turn: number
  readonly minutesAgo: number
}

/** A sample mark on a tool call a rule decided (`PermissionMark`). */
export interface SeedPermissionMark {
  /** The `toolUseId` of the sample tool call it's on. */
  readonly toolUseId: string
  readonly outcome: PermissionMarkOutcome
}

/** One sample tool log entry. */
export type SeedToolEvent = SeedNarration | SeedToolCall | SeedDivider | SeedCompaction

/** The states a sample tool call with an output can end in: any but running. */
export type FinishedToolCallState = Exclude<ToolCallState, ToolCallState.Running>

const FINISHED_TOOL_CALL_STATES = Object.values(ToolCallState).filter(
  (state): state is FinishedToolCallState => state !== ToolCallState.Running,
)

/** One sample task. Its times are relative to the capture, so relative times read the same on every run. */
export interface SeedTask {
  /** A fixed id, for a spec whose agent script names the task; a new one unless given. */
  readonly id?: string | undefined
  readonly title: string
  readonly objective?: string | undefined
  readonly status?: string | undefined
  readonly state?: TaskState | undefined
  /** What the task's agent is doing; waiting unless given. */
  readonly activity?: TaskActivity | undefined
  readonly pinned?: boolean | undefined
  readonly unread?: boolean | undefined
  /** The model id it runs on, as the SDK takes it (e.g. `opus[1m]`); the default for new tasks unless given. */
  readonly model?: string | undefined
  /** How much context the task's agent has used, in tokens; none unless given. */
  readonly contextUsedTokens?: number | undefined
  /** The task's context window, in tokens; its model's unless given. */
  readonly contextWindowTokens?: number | undefined
  /** Where the SDK said it compacts automatically; unknown (its default) unless given. */
  readonly autoCompact?: AutoCompact | undefined
  /** How long before the capture the task was last updated (and its status set, and it was marked done). */
  readonly minutesAgo: number
  /** How long before the capture the task was created; `minutesAgo` unless given. */
  readonly startedMinutesAgo?: number | undefined
  /** Select this task. */
  readonly selected?: boolean | undefined
  /** Its chat log, in order. */
  readonly messages?: readonly SeedMessage[] | undefined
  /** Its tool log, in order. */
  readonly toolEvents?: readonly SeedToolEvent[] | undefined
  /** The messages waiting in its queue, in order. */
  readonly queuedMessages?: readonly string[] | undefined
  /** What stopped its agent, with `activity: "error"`; none unless given. */
  readonly error?: TaskError | undefined
  /** Why its turn is paused, with `activity: "paused"`; none unless given. */
  readonly pause?: SeedPause | undefined
  /** Whether the relaunch notice names it, as a task Glade picked up again after it crashed. */
  readonly resumedAfterCrash?: boolean | undefined
  /** The files open in its Files tab, relative to the workspace root, and the one showing; none unless given. */
  readonly openFiles?: SeedOpenFiles | undefined
  /** The folders open in its Files tab's Browse tab, relative to the workspace root; none unless given. */
  readonly browseFolders?: readonly string[] | undefined
  /** The files and links declared as its artifacts (the Artifacts tab), in the order they were declared. */
  readonly artifacts?: readonly SeedArtifact[] | undefined
  /** Which of them the Artifacts tab shows (#407); all of them unless given. */
  readonly artifactFilter?: ArtifactFilter | undefined
  /** Its handoff note, from a backfill through the control API (the Backfilled card); none unless given. */
  readonly handoff?: SeedHandoff | undefined
  /** What its agent may do without asking; Allow all unless given. */
  readonly permissionMode?: PermissionMode | undefined
  /** Its agent's tool calls that wait, or waited, on your OK, in the order they asked. */
  readonly permissionRequests?: readonly SeedPermissionRequest[] | undefined
  /** Its tool calls a rule decided (a grant or task rule let through, or the sandbox blocked), by their `toolUseId`. */
  readonly permissionMarks?: readonly SeedPermissionMark[] | undefined
  /** An open question set (the question card) its agent asked; none unless given. */
  readonly questionSet?: SeedQuestionSet | undefined
  /** What its agent left running or scheduled (the Watchers tab), in the order it started them. */
  readonly watchers?: readonly SeedWatcher[] | undefined
  /** The commits it made (the Changes tab); none unless given. */
  readonly commits?: readonly SeedCommit[] | undefined
  /** How its todos' panels were left in the todo hub; each closed, showing all, unless given. */
  readonly todoPanels?: readonly SeedTodoPanel[] | undefined
  /**
   * Another workspace to put it in, made (once, by its root) beside the fixture's own, which stays the one open: for a
   * capture of what's in flight across workspaces (the menu bar popover). The fixture's workspace unless given.
   */
  readonly workspace?: SeedWorkspace | undefined
  /** The notifications Glade sent about it (the menu bar popover's Recent section), oldest first; none unless given. */
  readonly notifications?: readonly SeedNotification[] | undefined
}

/** A workspace in a fixture: its name, and its root (usually made up). */
export interface SeedWorkspace {
  readonly name: string
  readonly rootPath: string
}

/** A sample notification sent about a task, with its title: what it said, and how long before the capture. */
export interface SeedNotification {
  readonly body: string
  readonly minutesAgo: number
}

/**
 * A sample open question set (`QuestionSet`, the question card): the agent's `ask` call, still waiting on your
 * answers. Seeds can't express an answered or withdrawn one; only the card a capture or spec needs open.
 */
export interface SeedQuestionSet {
  /** What the agent said before its questions; none unless given. */
  readonly preamble?: string | undefined
  /** At least one. */
  readonly questions: readonly Question[]
  readonly turn: number
  readonly minutesAgo: number
}

/** A sample watcher (`Watcher`), started `minutesAgo`; running unless it has another `state`. */
export interface SeedWatcher {
  readonly kind: WatcherKind
  readonly toolUseId: string
  readonly label: string
  readonly detail: string
  readonly state?: WatcherState | undefined
  readonly minutesAgo: number
  /** How many times it has woken the agent; none unless given. */
  readonly wakes?: number | undefined
  /** How long before the capture it last woke the agent; never unless given. */
  readonly lastWokeMinutesAgo?: number | undefined
  /** How long after the capture it's next due, for a wakeup or a cron job that's scheduled; not due unless given. */
  readonly dueInMinutes?: number | undefined
  /** The `toolUseId` of the `Agent` call whose subagent started it; the task's own unless given. */
  readonly parentToolUseId?: string | undefined
  /** The last thing it reported; nothing unless given. */
  readonly lastOutput?: string | undefined
  /** How it ended, for one in an ended state; nothing unless given. */
  readonly outcome?: string | undefined
  /** How long before the capture it ended, for one in an ended state; not recorded unless given. */
  readonly endedMinutesAgo?: number | undefined
  /** The todo it's filed under in the hub; none unless given. */
  readonly todo?: SeedTodoId | undefined
}

/** A sample commit the task made (`TaskCommit`), in the workspace's own working tree, `minutesAgo`. */
export interface SeedCommit {
  /** Its full hash. */
  readonly hash: string
  readonly subject: string
  /** The branch it was made on; `main` unless given. */
  readonly branch?: string | undefined
  readonly additions: number
  readonly deletions: number
  /** How many files it changed; one unless given. */
  readonly filesChanged?: number | undefined
  /** The `toolUseId` of the sample `Bash` call that made it, which says which subagent did; not known unless given. */
  readonly toolUseId?: string | undefined
  readonly minutesAgo: number
  /** The todo it's filed under in the hub; none unless given. */
  readonly todo?: SeedTodoId | undefined
}

/** How a todo's panel was left in the hub (`TodoPanel`): the todo by its id, or `unfiled` for the placeholder group. */
export interface SeedTodoPanel {
  readonly todo: SeedTodoId
  readonly open: boolean
  /** Which of its children it shows; all of them unless given. */
  readonly filter?: ChildFilter | undefined
}

/**
 * A sample artifact (`Artifact`): a file, relative to the workspace root, or a link by its `url` (#407). Declared
 * `minutesAgo`, or at a time of day (`HH:MM`, local) `daysAgo` days before the capture's, so it lands in the date group
 * it's meant for whatever the time the capture runs; a file, when the workspace has one there, is marked as last
 * changed then too.
 */
export type SeedArtifact = SeedArtifactTarget & (SeedArtifactMinutesAgo | SeedArtifactDaysAgo) & SeedFiled

/** Where a sample child is filed in the todo hub. */
export interface SeedFiled {
  /** The todo it's filed under; none unless given. */
  readonly todo?: SeedTodoId | undefined
}

/** Which artifact a sample is: a file of the workspace, or a link. */
export type SeedArtifactTarget = { readonly path: string } | { readonly url: string }

export interface SeedArtifactMinutesAgo {
  readonly title: string
  readonly minutesAgo: number
}

export interface SeedArtifactDaysAgo {
  readonly title: string
  readonly daysAgo: number
  /** The time of day, `HH:MM`, 24-hour, in the local time zone. */
  readonly time: string
}

/** When a sample artifact was declared: `minutesAgo` before `now`, or at its time of day `daysAgo` days before. */
export function seedArtifactAt(artifact: SeedArtifact, now: EpochMs): EpochMs {
  if ('minutesAgo' in artifact) return now - artifact.minutesAgo * MINUTE
  const [hours = 0, minutes = 0] = artifact.time.split(':').map(Number)
  const today = new Date(now)
  const at = new Date(today.getFullYear(), today.getMonth(), today.getDate() - artifact.daysAgo, hours, minutes)
  // Today at a time still to come is now.
  return Math.min(at.getTime(), now)
}

/** A sample handoff note (`TaskHandoff`): Markdown, set `minutesAgo`. */
export interface SeedHandoff {
  readonly body: string
  readonly minutesAgo: number
}

/** A task's open files (`OpenFiles`). */
export interface SeedOpenFiles {
  readonly paths: readonly string[]
  /** The one showing, or null for the Browse tab; the first unless given. */
  readonly activePath?: string | null | undefined
}

/** A sample pause (`TaskPause`), with its times relative to the capture. */
export interface SeedPause {
  readonly reason: PauseReason
  /** How long after the capture it resumes. */
  readonly resumesInMinutes: number
  readonly details: string
}

/** The account the tasks ran on, as Claude Code reported it (`Account`): each field left out is one it didn't give. */
export interface SeedAccount {
  readonly email?: string | undefined
  readonly organization?: string | undefined
  readonly subscriptionType?: string | undefined
  readonly tokenSource?: string | undefined
  readonly apiKeySource?: string | undefined
  readonly apiProvider?: string | undefined
  /** How long before the capture it was read. */
  readonly readMinutesAgo: number
}

/** A usage limit's reading at the capture (`UsageReading`). */
export interface SeedUsageReading {
  readonly kind: UsageLimitKind
  /** The model a per-model weekly limit counts (`UsageLimitKind.WeeklyModel` only), e.g. `Opus`. */
  readonly model?: string | undefined
  readonly utilization: number | null
  /** Where the limit stands; by `utilization` unless given (`usageLevel`). */
  readonly level?: UsageLevel | undefined
  /** How long after the capture its window resets; null for a reading with no reset time. */
  readonly resetsInMinutes: number | null
  /** How long before the capture it was read. */
  readonly readMinutesAgo: number
  /**
   * What the usage call said of extra usage (`UsageLimitKind.ExtraUsage` only): whether it's available, and the money
   * spent, in the currency's minor units. None unless given.
   */
  readonly extraUsage?: ExtraUsageStatus | undefined
}

/** A fixture: one workspace, opened, and its tasks. */
export interface CaptureSeed {
  /**
   * The workspace. Its root is usually made up (the Files tab then finds no files); a relative root is a folder beside
   * the fixture, for a capture that shows files. With `files`, a made-up root (`/Users/sample/code/docs`, which shows as
   * `~/code/docs`) stands for that folder of sample files (relative to the fixture), so a capture shows the files
   * without showing where they are on the machine that makes it.
   */
  readonly workspace: {
    readonly id?: string | undefined
    readonly name: string
    readonly rootPath: string
    readonly files?: string | undefined
  }
  readonly tasks: readonly SeedTask[]
  /** Settings to change from their defaults, e.g. `controlEnabled`; none unless given. */
  readonly settings?: SettingsPatch | undefined
  /**
   * The control API's token, so Settings › Control shows a placeholder rather than a random, real-looking one; a new
   * random one (made when the switch is on) unless given. It must still look like a token: 43 base64url characters.
   */
  readonly controlToken?: string | undefined
  /** The right panel's tab to open on (`PanelTab`, e.g. `subagents`); Tool calls unless given. */
  readonly panelTab?: string | undefined
  /** The right panel's width, in CSS pixels; the default unless given. */
  readonly panelWidth?: number | undefined
  /** The plugin card's width beside the terminal, in CSS pixels; the default unless given. */
  readonly pluginWidth?: number | undefined
  /** The panels to show collapsed; each is open unless given. */
  readonly collapsed?: SeedCollapsed | undefined
  /** The account Settings › General shows; none read unless given. */
  readonly account?: SeedAccount | undefined
  /** The usage meter's readings; none unless given. */
  readonly usage?: readonly SeedUsageReading[] | undefined
  /** The models the SDK offers, as a session reported them (`ModelChoice`); the built-in list unless given. */
  readonly models?: readonly ModelChoice[] | undefined
  /** The sandbox grants Settings lists (#451); none unless given. */
  readonly sandboxGrants?: SeedSandboxGrants | undefined
  /**
   * The MCP servers the fixture's workspace's sessions have reported (#515), which Settings' MCP servers lists offer
   * under Add…; none unless given.
   */
  readonly reportedServers?: readonly ReportedMcpServer[] | undefined
}

/**
 * Sample sandbox grants, in the order they were granted: the Glade-wide ones (Settings › Agent) and the fixture's
 * workspace's (Settings › Workspace). Saved as written: a fixture's folders are made up, so nothing is resolved.
 */
export interface SeedSandboxGrants {
  readonly glade?: readonly Grant[] | undefined
  readonly workspace?: readonly Grant[] | undefined
}

/** Which panels a seed collapses. */
export interface SeedCollapsed {
  readonly sidebar?: boolean | undefined
  readonly rightPanel?: boolean | undefined
  readonly bottomBar?: boolean | undefined
}

const turn = z.int().positive()
const minutesAgo = z.number().nonnegative()
const count = z.int().nonnegative()
/** A time of day, `HH:MM`, 24-hour. */
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

/** A todo's id as Claude Code gives it (`SeedTodoId`). */
const seedTodoId = z.string().min(1)

const seedSummarySchema = z.strictObject({
  durationMs: count.nullable(),
  filesChanged: count,
  linesAdded: count,
  linesRemoved: count,
})

const seedToolEventSchema: z.ZodType<SeedToolEvent> = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal(ToolEventKind.Narration),
    text: z.string(),
    parentToolUseId: z.string().optional(),
    turn,
    minutesAgo,
  }),
  z.strictObject({
    kind: z.literal(ToolEventKind.ToolCall),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
    output: z.string().optional(),
    state: z.enum(FINISHED_TOOL_CALL_STATES).optional(),
    toolUseId: z.string().optional(),
    parentToolUseId: z.string().optional(),
    turn,
    minutesAgo,
    finishedMinutesAgo: minutesAgo.optional(),
    progressSummary: z.string().optional(),
    todo: seedTodoId.optional(),
  }),
  z.strictObject({ kind: z.literal(ToolEventKind.Divider), dividerKind: z.enum(DividerKind), turn, minutesAgo }),
  z.strictObject({
    kind: z.literal(ToolEventKind.Compaction),
    trigger: z.enum(CompactionTrigger),
    state: z.enum(ToolCallState).optional(),
    preTokens: count.nullable(),
    postTokens: count.nullable(),
    windowTokens: z.int().positive(),
    summary: z.string().optional(),
    turn,
    minutesAgo,
  }),
])

const seedErrorSchema = z.strictObject({
  kind: z.enum(AgentErrorKind),
  source: z.enum(TaskErrorSource),
  status: z.int().nullable(),
  code: z.string().nullable(),
  details: z.string(),
  retries: count,
  retryingMs: count,
}) satisfies z.ZodType<TaskError>

const seedPauseSchema = z.strictObject({
  reason: z.enum(PauseReason),
  resumesInMinutes: minutesAgo,
  details: z.string(),
}) satisfies z.ZodType<SeedPause>

const seedAccountSchema = z.strictObject({
  email: z.string().optional(),
  organization: z.string().optional(),
  subscriptionType: z.string().optional(),
  tokenSource: z.string().optional(),
  apiKeySource: z.string().optional(),
  apiProvider: z.string().optional(),
  readMinutesAgo: minutesAgo,
}) satisfies z.ZodType<SeedAccount>

const seedGrant = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal(SandboxGrantKind.Folder), path: z.string().min(1), access: z.enum(FolderAccess) }),
  z.strictObject({ kind: z.literal(SandboxGrantKind.Domain), domain: z.string().min(1) }),
  z.strictObject({
    kind: z.literal(SandboxGrantKind.McpServer),
    server: z.string().min(1),
    name: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal(SandboxGrantKind.Agents), agents: z.enum(OtherAgents) }),
]) satisfies z.ZodType<Grant>

const seedUsageReadingSchema = z
  .strictObject({
    kind: z.enum(UsageLimitKind),
    model: z.string().min(1).optional(),
    utilization: z.number().nonnegative().nullable(),
    level: z.enum(UsageLevel).optional(),
    resetsInMinutes: minutesAgo.nullable(),
    readMinutesAgo: minutesAgo,
    extraUsage: z
      .strictObject({
        available: z.boolean(),
        spend: z
          .strictObject({
            spent: z.number().nonnegative(),
            cap: z.number().nonnegative().nullable(),
            currency: z.string().regex(/^[A-Z]{3}$/),
            decimalPlaces: z.number().int().min(0).max(4),
          })
          .nullable(),
      })
      .optional(),
  })
  .refine(({ kind, model }) => (kind === UsageLimitKind.WeeklyModel) === (model !== undefined), {
    message: 'a model is given for a per-model weekly limit, and only for one',
  })
  .refine(({ kind, extraUsage }) => kind === UsageLimitKind.ExtraUsage || extraUsage === undefined, {
    message: 'only extra usage’s reading says what the usage call said of extra usage',
  }) satisfies z.ZodType<SeedUsageReading>

/** The limit a seed's reading is of. */
function seedUsageLimit({ kind, model }: SeedUsageReading): UsageLimit {
  return kind === UsageLimitKind.WeeklyModel ? { kind, model: model ?? '' } : { kind }
}

const seedSchema: z.ZodType<CaptureSeed> = z.strictObject({
  workspace: z.strictObject({
    id: z.string().optional(),
    name: z.string(),
    rootPath: z.string(),
    files: z.string().optional(),
  }),
  account: seedAccountSchema.optional(),
  usage: z.array(seedUsageReadingSchema).optional(),
  models: z
    .array(
      z.strictObject({
        id: z.string(),
        resolvedModel: z.string().nullable(),
        name: z.string(),
        description: z.string(),
        efforts: z.array(z.enum(Effort)).readonly(),
      }),
    )
    .optional(),
  settings: z.strictObject(SETTING_SCHEMAS).partial().optional(),
  sandboxGrants: z
    .strictObject({ glade: z.array(seedGrant).optional(), workspace: z.array(seedGrant).optional() })
    .optional(),
  reportedServers: z.array(z.strictObject({ server: z.string().min(1), name: z.string().min(1) })).optional(),
  controlToken: storedToken.optional(),
  panelTab: z.string().optional(),
  panelWidth: z.int().positive().optional(),
  pluginWidth: z.int().positive().optional(),
  collapsed: z
    .strictObject({
      sidebar: z.boolean().optional(),
      rightPanel: z.boolean().optional(),
      bottomBar: z.boolean().optional(),
    })
    .optional(),
  tasks: z.array(
    z.strictObject({
      id: z.string().optional(),
      title: z.string(),
      objective: z.string().optional(),
      status: z.string().optional(),
      state: z.enum(TaskState).optional(),
      activity: z.enum(TaskActivity).optional(),
      pinned: z.boolean().optional(),
      unread: z.boolean().optional(),
      model: z.string().optional(),
      contextUsedTokens: z.int().nonnegative().optional(),
      contextWindowTokens: z.int().positive().optional(),
      autoCompact: z
        .discriminatedUnion('kind', [
          z.strictObject({ kind: z.literal(AutoCompactKind.On), thresholdTokens: count }),
          z.strictObject({ kind: z.literal(AutoCompactKind.Off) }),
        ])
        .optional(),
      minutesAgo,
      startedMinutesAgo: minutesAgo.optional(),
      selected: z.boolean().optional(),
      messages: z
        .array(
          z.strictObject({
            role: z.enum(MessageRole),
            body: z.string(),
            turn,
            minutesAgo,
            summary: seedSummarySchema.optional(),
            broadcast: z.boolean().optional(),
          }),
        )
        .optional(),
      toolEvents: z.array(seedToolEventSchema).optional(),
      queuedMessages: z.array(z.string()).optional(),
      error: seedErrorSchema.optional(),
      pause: seedPauseSchema.optional(),
      resumedAfterCrash: z.boolean().optional(),
      openFiles: z
        .strictObject({ paths: z.array(z.string()), activePath: z.string().nullable().optional() })
        .optional(),
      browseFolders: z.array(z.string()).optional(),
      artifacts: z
        .array(
          z.union([
            z.strictObject({ path: z.string(), title: z.string(), minutesAgo, todo: seedTodoId.optional() }),
            z.strictObject({ url: z.url(), title: z.string(), minutesAgo, todo: seedTodoId.optional() }),
            z.strictObject({
              path: z.string(),
              title: z.string(),
              daysAgo: count,
              time: timeOfDay,
              todo: seedTodoId.optional(),
            }),
            z.strictObject({
              url: z.url(),
              title: z.string(),
              daysAgo: count,
              time: timeOfDay,
              todo: seedTodoId.optional(),
            }),
          ]),
        )
        .optional(),
      artifactFilter: z.enum(ArtifactFilter).optional(),
      handoff: z.strictObject({ body: z.string().min(1), minutesAgo }).optional(),
      permissionMode: z.enum(PermissionMode).optional(),
      workspace: z.strictObject({ name: z.string(), rootPath: z.string() }).optional(),
      notifications: z.array(z.strictObject({ body: z.string(), minutesAgo })).optional(),
      permissionMarks: z
        .array(z.strictObject({ toolUseId: z.string(), outcome: permissionMarkOutcomeSchema }))
        .optional(),
      permissionRequests: z
        .array(
          z.strictObject({
            toolName: z.string(),
            input: z.record(z.string(), z.unknown()),
            toolUseId: z.string(),
            agentId: z.string().optional(),
            title: z.string().optional(),
            description: z.string().optional(),
            defaultToNo: z.boolean().optional(),
            suggestedRule: z.string().optional(),
            state: z.enum(PermissionRequestState).optional(),
            denyNote: z.string().optional(),
            forTask: z.boolean().optional(),
            sandbox: sandboxAskSchema.optional(),
            grantedScope: z.enum([SandboxGrantScope.Task, SandboxGrantScope.Workspace]).optional(),
            turn,
            minutesAgo,
          }),
        )
        .optional(),
      questionSet: z
        .strictObject({
          preamble: preambleSchema.optional(),
          questions: questionsSchema,
          turn,
          minutesAgo,
        })
        .optional(),
      watchers: z
        .array(
          z.strictObject({
            kind: z.enum(WatcherKind),
            toolUseId: z.string(),
            label: z.string(),
            detail: z.string(),
            state: z.enum(WatcherState).optional(),
            minutesAgo,
            wakes: count.optional(),
            lastWokeMinutesAgo: minutesAgo.optional(),
            dueInMinutes: minutesAgo.optional(),
            parentToolUseId: z.string().optional(),
            lastOutput: z.string().optional(),
            outcome: z.string().optional(),
            endedMinutesAgo: minutesAgo.optional(),
            todo: seedTodoId.optional(),
          }),
        )
        .optional(),
      commits: z
        .array(
          z.strictObject({
            hash: z.string().regex(/^[0-9a-f]{40}$/, 'must be a full hash: 40 hex digits'),
            subject: z.string(),
            branch: z.string().optional(),
            additions: count,
            deletions: count,
            filesChanged: count.optional(),
            toolUseId: z.string().optional(),
            minutesAgo,
            todo: seedTodoId.optional(),
          }),
        )
        .optional(),
      todoPanels: z
        .array(z.strictObject({ todo: seedTodoId, open: z.boolean(), filter: z.enum(ChildFilter).optional() }))
        .optional(),
    }),
  ),
})

/** Adds a sample watcher to a task, started `at`, as it stands at `now`. */
function seedWatcher(db: Database, taskId: string, watcher: SeedWatcher, at: EpochMs, now: EpochMs): void {
  const { kind, toolUseId, label, detail, lastOutput, outcome, endedMinutesAgo } = watcher
  const { wakes, lastWokeMinutesAgo, dueInMinutes } = watcher
  const added = addWatcher(
    db,
    {
      taskId,
      kind,
      toolUseId,
      parentToolUseId: watcher.parentToolUseId ?? null,
      sdkId: null,
      label,
      detail,
      cron: null,
      schedule: null,
      recurring: false,
      state: watcher.state ?? WatcherState.Running,
      nextDueAt: null,
      expiresAt: null,
    },
    at,
  )
  updateWatcher(db, added.id, {
    ...(wakes === undefined ? {} : { wakes }),
    ...(lastWokeMinutesAgo === undefined ? {} : { lastWokeAt: now - lastWokeMinutesAgo * MINUTE }),
    ...(dueInMinutes === undefined ? {} : { nextDueAt: now + dueInMinutes * MINUTE }),
    ...(lastOutput === undefined ? {} : { lastOutput }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(endedMinutesAgo === undefined ? {} : { endedAt: now - endedMinutesAgo * MINUTE }),
  })
}

/** Links a sample commit to a task, as if made in the workspace's own working tree. Answers which child it is. */
function seedCommit(db: Database, taskId: string, rootPath: string, commit: SeedCommit, now: EpochMs): ChildRef {
  const committedAt = now - commit.minutesAgo * MINUTE
  const added = addTaskCommit(
    db,
    {
      taskId,
      gitDir: join(rootPath, '.git'),
      repoPath: rootPath,
      hash: commit.hash,
      subject: commit.subject,
      branch: commit.branch ?? 'main',
      committedAt,
      additions: commit.additions,
      deletions: commit.deletions,
      filesChanged: commit.filesChanged ?? 1,
      parents: 1,
      toolUseId: commit.toolUseId ?? null,
      source: CommitSource.Printed,
    },
    committedAt,
  )
  return childOfCommit(added)
}

/** Reads and checks a seed fixture. Throws when it can't be read or isn't a valid fixture. */
export function readSeed(path: string): CaptureSeed {
  let json: unknown
  try {
    json = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`the seed ${path} can't be read: ${(error as Error).message}`, { cause: error })
  }
  const parsed = seedSchema.safeParse(json)
  if (!parsed.success) throw new Error(`the seed ${path} is invalid: ${z.prettifyError(parsed.error)}`)
  const { workspace } = parsed.data
  const beside = (folder: string): string => resolve(dirname(path), folder)
  return {
    ...parsed.data,
    workspace: {
      ...workspace,
      rootPath: isAbsolute(workspace.rootPath) ? workspace.rootPath : beside(workspace.rootPath),
      ...(workspace.files === undefined ? {} : { files: beside(workspace.files) }),
    },
  }
}

function seedToolEvent(db: Database, taskId: string, event: SeedToolEvent, now: EpochMs, seedId: string): void {
  const at = now - event.minutesAgo * MINUTE
  switch (event.kind) {
    case ToolEventKind.Narration: {
      const { turn, text, parentToolUseId } = event
      appendNarration(db, { taskId, turn, text, parentToolUseId }, at)
      return
    }
    case ToolEventKind.Divider:
      appendDivider(db, { taskId, turn: event.turn, dividerKind: event.dividerKind }, at)
      return
    case ToolEventKind.ToolCall: {
      const { name, input, output, turn } = event
      const toolUseId = event.toolUseId ?? seedId
      appendToolCall(db, { taskId, turn, name, input, toolUseId, parentToolUseId: event.parentToolUseId ?? null }, at)
      if (output !== undefined) {
        const finishedAt = event.finishedMinutesAgo === undefined ? at : now - event.finishedMinutesAgo * MINUTE
        updateToolCall(db, { taskId, toolUseId, state: event.state ?? ToolCallState.Done, output }, finishedAt)
      }
      if (event.progressSummary !== undefined) {
        setSubagentProgress(db, { taskId, toolUseId, summary: event.progressSummary })
      }
      return
    }
    case ToolEventKind.Compaction: {
      const { trigger, preTokens, postTokens, windowTokens, summary, turn } = event
      const state = event.state ?? ToolCallState.Done
      appendCompaction(db, { taskId, turn, trigger, state, preTokens, postTokens, windowTokens, summary }, at)
      return
    }
  }
}

/** The suggestions Claude Code makes for a sample request: adding its suggested rule, for a settings file. */
function seedSuggestions(request: SeedPermissionRequest): PermissionSuggestion[] {
  if (request.suggestedRule === undefined) return []
  return [
    {
      type: PermissionUpdateType.AddRules,
      rules: [{ toolName: request.toolName, ruleContent: request.suggestedRule }],
      behavior: PermissionRuleBehavior.Allow,
      destination: PermissionDestination.LocalSettings,
    },
  ]
}

/** How a sample permission request closed, or null for one still open. */
function seedClosing(request: SeedPermissionRequest): PermissionRequestClosing | null {
  switch (request.state ?? PermissionRequestState.Open) {
    case PermissionRequestState.Open:
      return null
    case PermissionRequestState.Allowed: {
      if (request.grantedScope !== undefined) {
        return { state: PermissionRequestState.Allowed, grantedScope: request.grantedScope }
      }
      const rule =
        request.forTask === true
          ? taskPermissionRule({
              toolName: request.toolName,
              suggestions: seedSuggestions(request),
              suppressAlwaysAllowRule: false,
            })
          : null
      if (request.forTask === true && rule === null) {
        throw new Error(`The sample ${request.toolName} call ${request.toolUseId} can't be allowed for the task`)
      }
      return rule === null
        ? { state: PermissionRequestState.Allowed }
        : { state: PermissionRequestState.Allowed, grantedRule: rule }
    }
    case PermissionRequestState.Denied:
      return { state: PermissionRequestState.Denied, note: request.denyNote ?? null }
    case PermissionRequestState.Withdrawn:
      return { state: PermissionRequestState.Withdrawn }
  }
}

function seedPermissionRequest(db: Database, taskId: string, request: SeedPermissionRequest, at: EpochMs): void {
  const opened = appendPermissionRequest(
    db,
    {
      taskId,
      turn: request.turn,
      toolUseId: request.toolUseId,
      agentId: request.agentId ?? null,
      toolName: request.toolName,
      input: request.input,
      title: request.title ?? null,
      displayName: request.toolName,
      description: request.description ?? null,
      suggestions: seedSuggestions(request),
      defaultToNo: request.defaultToNo ?? false,
      // Nothing that asks of the sandbox is remembered as a rule.
      suppressAlwaysAllowRule: request.sandbox !== undefined,
      sandbox: request.sandbox ?? null,
    },
    at,
  )
  const closing = seedClosing(request)
  if (closing !== null) closePermissionRequest(db, opened.id, closing, at)
  if (closing?.state === PermissionRequestState.Allowed && closing.grantedRule !== undefined) {
    addTaskPermissionRule(db, { taskId, rule: closing.grantedRule }, at)
  }
}

/** Writes a seed into the database as if it had been used up to `now`: the workspace open, the selected task shown. */
export function applySeed(db: Database, seed: CaptureSeed, now: EpochMs = Date.now()): void {
  db.transaction(() => {
    if (seed.settings !== undefined) updateSettings(db, seed.settings)
    if (seed.controlToken !== undefined) storeControlToken(db, seed.controlToken)
    if (seed.models !== undefined) setSdkModels(db, seed.models)
    if (seed.account !== undefined) {
      const { readMinutesAgo, ...fields } = seed.account
      saveAccount(db, {
        email: fields.email ?? null,
        organization: fields.organization ?? null,
        subscriptionType: fields.subscriptionType ?? null,
        tokenSource: fields.tokenSource ?? null,
        apiKeySource: fields.apiKeySource ?? null,
        apiProvider: fields.apiProvider ?? null,
        readAt: now - readMinutesAgo * MINUTE,
      })
    }
    if (seed.usage !== undefined) {
      replaceUsageReadings(
        db,
        seed.usage.map((reading) => ({
          limit: seedUsageLimit(reading),
          utilization: reading.utilization,
          resetsAt: reading.resetsInMinutes === null ? null : now + reading.resetsInMinutes * MINUTE,
          level: reading.level ?? usageLevel(reading.utilization),
          readAt: now - reading.readMinutesAgo * MINUTE,
          ...(reading.extraUsage === undefined ? {} : { extraUsage: reading.extraUsage }),
        })),
      )
    }
    const { files, ...shown } = seed.workspace
    // The made-up root reads its files from the fixture's folder of sample files.
    if (files !== undefined) standInForWorkspaceRoot(shown.rootPath, files)
    const workspace = createWorkspace(db, shown, now)
    setUiState(db, { key: UiStateKey.ActiveWorkspaceId, value: workspace.id })
    const granted: readonly [SandboxGrantTarget, readonly Grant[] | undefined][] = [
      [{ scope: SandboxGrantScope.Glade }, seed.sandboxGrants?.glade],
      [{ scope: SandboxGrantScope.Workspace, workspaceId: workspace.id }, seed.sandboxGrants?.workspace],
    ]
    for (const [target, grants] of granted) {
      // A millisecond apart, so each list keeps the fixture's order.
      for (const [index, grant] of (grants ?? []).entries()) addSandboxGrant(db, { target, grant }, now + index)
    }
    noteReportedServers(db, workspace.id, seed.reportedServers ?? [], now)
    if (seed.panelTab !== undefined) setUiState(db, { key: UiStateKey.RightPanelTab, value: seed.panelTab })
    if (seed.panelWidth !== undefined) {
      setUiState(db, { key: UiStateKey.RightPanelWidth, value: String(seed.panelWidth) })
    }
    if (seed.pluginWidth !== undefined) {
      setUiState(db, { key: UiStateKey.PluginWidth, value: String(seed.pluginWidth) })
    }
    for (const [key, collapsed] of [
      [UiStateKey.SidebarCollapsed, seed.collapsed?.sidebar],
      [UiStateKey.RightPanelCollapsed, seed.collapsed?.rightPanel],
      [UiStateKey.BottomBarCollapsed, seed.collapsed?.bottomBar],
    ] as const) {
      if (collapsed !== undefined) setUiState(db, { key, value: String(collapsed) })
    }
    const resumed: string[] = []
    // The other workspaces the tasks go in, made as the first task in each needs it.
    const workspaceOf = (sample: SeedTask): string => {
      if (sample.workspace === undefined) return workspace.id
      const found = getWorkspaceByRoot(db, sample.workspace.rootPath)
      return (found ?? createWorkspace(db, sample.workspace, now)).id
    }
    for (const [index, sample] of seed.tasks.entries()) {
      const at = now - sample.minutesAgo * MINUTE
      const createdAt = now - (sample.startedMinutesAgo ?? sample.minutesAgo) * MINUTE
      const newTask = {
        ...(sample.id === undefined ? {} : { id: sample.id }),
        workspaceId: workspaceOf(sample),
        model: sample.model ?? DEFAULT_SETTINGS.defaultModel,
        effort: DEFAULT_SETTINGS.defaultEffort,
        permissionMode: sample.permissionMode ?? DEFAULT_SETTINGS.defaultPermissionMode,
      }
      const task = createTask(db, newTask, createdAt)
      updateTask(
        db,
        task.id,
        {
          title: sample.title,
          objective: sample.objective ?? '',
          status: sample.status ?? '',
          state: sample.state ?? TaskState.Active,
          activity: sample.activity ?? TaskActivity.Waiting,
          pinned: sample.pinned ?? false,
          unread: sample.unread ?? false,
          contextUsedTokens: sample.contextUsedTokens,
          contextWindowTokens: sample.contextWindowTokens,
          autoCompact: sample.autoCompact,
          error: sample.error ?? null,
          pause:
            sample.pause === undefined
              ? null
              : {
                  reason: sample.pause.reason,
                  since: at,
                  resumesAt: now + sample.pause.resumesInMinutes * MINUTE,
                  checks: 0,
                  details: sample.pause.details,
                },
          // A titled task has run (its agent named it), so it has a session: e.g. it can need you.
          sessionId: sample.title === '' ? null : `seed-session-${String(index)}`,
        },
        at,
      )
      // Its session started with Glade's prompt as it is now, so it isn't sent the lines added since
      // (`INSTRUCTION_UPDATES`), nor what the prompt says of the sandbox or of the todo hub. A handoff note is as it
      // was: one set by the seed goes to the session once.
      if (sample.title !== '') {
        setSessionContext(db, task.id, {
          instructions: true,
          instructionUpdates: INSTRUCTION_UPDATES.length,
          handoffAt: null,
          sandbox: true,
          todoHub: true,
        })
      }
      if (sample.selected === true) setUiState(db, { key: UiStateKey.SelectedTaskId, value: task.id })
      const ago = (minutes: number): EpochMs => now - minutes * MINUTE
      for (const { role, body, turn, summary, broadcast, minutesAgo } of sample.messages ?? []) {
        appendMessage(db, { taskId: task.id, role, body, turn, summary, broadcast }, ago(minutesAgo))
      }
      // The sample children filed under a todo in the hub, in the order the fixture has them.
      const filings: NewFiling[] = []
      const fileUnder = (todo: SeedTodoId | undefined, child: ChildRef): void => {
        if (todo !== undefined) filings.push({ ...child, todoId: todo, source: FilingSource.Named })
      }
      for (const [index, event] of (sample.toolEvents ?? []).entries()) {
        const seedId = `seed-${String(index)}`
        seedToolEvent(db, task.id, event, now, seedId)
        if (event.kind === ToolEventKind.ToolCall) {
          fileUnder(event.todo, { kind: ChildKind.Subagent, key: event.toolUseId ?? seedId })
        }
      }
      refreshTodos(db, task.id)
      for (const body of sample.queuedMessages ?? []) appendQueuedMessage(db, { taskId: task.id, body }, now)
      if (sample.openFiles !== undefined) {
        const { paths, activePath } = sample.openFiles
        setOpenFiles(db, {
          taskId: task.id,
          paths,
          activePath: activePath === undefined ? (paths[0] ?? null) : activePath,
        })
      }
      for (const path of sample.browseFolders ?? []) {
        setBrowseFolderExpanded(db, { taskId: task.id, path, expanded: true })
      }
      for (const artifact of sample.artifacts ?? []) {
        const declaredAt = seedArtifactAt(artifact, now)
        if ('url' in artifact) {
          const added = addLinkArtifact(db, { taskId: task.id, url: artifact.url, title: artifact.title }, declaredAt)
          fileUnder(artifact.todo, childOfArtifact(added))
          continue
        }
        const { path, title } = artifact
        fileUnder(artifact.todo, childOfArtifact(addArtifact(db, { taskId: task.id, path, title }, declaredAt)))
        const file = join(workspaceFilesRoot(seed.workspace.rootPath), path)
        const there = existsSync(file)
        if (there) utimesSync(file, new Date(declaredAt), new Date(declaredAt))
        // As if Glade had looked at it then: the tab lists it by that time, or shows it missing.
        setArtifactFile(db, {
          taskId: task.id,
          path,
          file: there ? { missing: false, modifiedAt: declaredAt } : { missing: true },
        })
      }
      if (sample.artifactFilter !== undefined) setArtifactFilter(db, task.id, sample.artifactFilter)
      if (sample.handoff !== undefined) setHandoff(db, task.id, sample.handoff.body, ago(sample.handoff.minutesAgo))
      for (const request of sample.permissionRequests ?? []) {
        seedPermissionRequest(db, task.id, request, ago(request.minutesAgo))
      }
      for (const { toolUseId, outcome } of sample.permissionMarks ?? []) {
        setPermissionMark(db, { taskId: task.id, toolUseId, outcome }, now)
      }
      if (sample.questionSet !== undefined) {
        const { preamble, questions, turn, minutesAgo } = sample.questionSet
        appendQuestionSet(db, { taskId: task.id, turn, preamble, questions }, ago(minutesAgo))
      }
      for (const watcher of sample.watchers ?? []) {
        seedWatcher(db, task.id, watcher, ago(watcher.minutesAgo), now)
        fileUnder(watcher.todo, { kind: ChildKind.Watcher, key: watcher.toolUseId })
      }
      for (const commit of sample.commits ?? []) {
        fileUnder(commit.todo, seedCommit(db, task.id, seed.workspace.rootPath, commit, now))
      }
      // Filed as main files any child, with no window to tell yet. Nothing is filed while the hub is off.
      fileChildren({ db, emit: () => undefined }, task.id, filings, now)
      for (const { todo, open, filter } of sample.todoPanels ?? []) {
        setTodoPanel(db, { taskId: task.id, todoId: todo, open, filter: filter ?? ChildFilter.All })
      }
      for (const { body, minutesAgo } of sample.notifications ?? []) {
        recordNotification(db, { taskId: task.id, title: sample.title, body }, ago(minutesAgo))
      }
      if (sample.resumedAfterCrash === true) resumed.push(task.id)
    }
    if (resumed.length > 0) {
      setUiState(db, { key: UiStateKey.RelaunchNotice, value: serializeRelaunchNotice({ taskIds: resumed }) })
    }
  })()
}
