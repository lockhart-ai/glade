/**
 * The seam between the agent runner and the Claude Agent SDK. The runner only ever talks to an `AgentBackend`: the app
 * starts with the real one (`createSdkBackend` in `./sdk-backend`), and tests (and, later, the end-to-end tests' test
 * mode) pass a scripted one instead.
 */
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type {
  CompactionTrigger,
  Effort,
  PermissionMode,
  PermissionRule,
  PermissionSuggestion,
  ToolInput,
} from '../../shared/domain'
import type { ImageData } from '../../shared/images'
import type { Logger } from '../logging/logger'

/**
 * In-process MCP servers to give a session, by server name, e.g. `{ glade: createSdkMcpServer({ name: 'glade', … }) }`.
 * Create them with `alwaysLoad: true`, or the model has to find their tools through tool search first
 * (`docs/sdk-notes.md` §3).
 */
export type AgentMcpServers = Readonly<Record<string, McpServerConfig>>

/**
 * The settings a task can change (`docs/sdk-notes.md` §4): the model and effort between turns, and the permission mode
 * at any time, even mid-turn (§9).
 */
export interface AgentSessionSettings {
  /** The model id, as the SDK names it. */
  readonly model: string
  readonly effort: Effort
  readonly permissionMode: PermissionMode
}

/** The MCP server serving a tool, as the SDK names it: its name, and where it was defined (`sdk` for the host's own). */
export interface McpServerOrigin {
  readonly name: string
  readonly source: string
}

/**
 * A tool call Claude Code asks the host about before running it (the SDK's `canUseTool`, `docs/sdk-notes.md` §9),
 * parsed at the SDK boundary.
 */
export interface ToolPermissionCall {
  readonly toolName: string
  readonly input: ToolInput
  /** The call's `tool_use` id: parallel calls each ask with their own. */
  readonly toolUseId: string
  /** The SDK's id for the subagent making the call; null for the agent's own. */
  readonly agentId: string | null
  readonly title: string | null
  readonly displayName: string | null
  readonly description: string | null
  readonly suggestions: readonly PermissionSuggestion[]
  readonly defaultToNo: boolean
  readonly suppressAlwaysAllowRule: boolean
  /** The server serving an `mcp__*` tool; null for any other tool, and when the SDK doesn't say. */
  readonly mcpServer: McpServerOrigin | null
  /** Whether a user `permissions.ask` rule forced the prompt. */
  readonly matchedAskRule: boolean
  /**
   * The path a `Bash` call's path check stopped at, outside the folders it may use; null for every other call. A file
   * tool's ask about a path outside them names it only in its input (`docs/sdk-notes.md` §15).
   */
  readonly blockedPath: string | null
  /**
   * Why Claude Code asked, in its words, e.g. `Path is outside allowed working directories` for a file tool outside the
   * folders it may use, or `dangerouslyDisableSandbox` for a command that asks to run outside the sandbox; null when it
   * doesn't say (`docs/sdk-notes.md` §15).
   */
  readonly decisionReason: string | null
  /** Aborted when the SDK cancels the call, e.g. on an interrupt. */
  readonly signal: AbortSignal
}

/** What the host answers a tool call with. */
export enum ToolPermissionBehavior {
  Allow = 'allow',
  Deny = 'deny',
}

/**
 * The answer to a tool call: run it, or don't, with the message the agent gets. `byUser` says a person decided it (Allow
 * once, Allow for this task, Deny), rather than Glade allowing it without asking, or withdrawing it. `rule` is the rule
 * Allow for this task granted: the session adds it, so the calls it covers stop asking at once.
 */
export type ToolPermissionAnswer =
  | { readonly behavior: ToolPermissionBehavior.Allow; readonly byUser: boolean; readonly rule?: PermissionRule }
  | { readonly behavior: ToolPermissionBehavior.Deny; readonly message: string; readonly byUser: boolean }

/** Decides a tool call Claude Code asks about, however long that takes. */
export type ToolPermissionHandler = (call: ToolPermissionCall) => Promise<ToolPermissionAnswer>

/** Whether a prompt about to start a turn goes ahead (`SessionHooks.onPrompt`). */
export enum PromptVerdict {
  Allow = 'allow',
  /** Turned away: the SDK runs no turn for it, and the model never sees it (`docs/sdk-notes.md` §13). */
  Block = 'block',
}

/**
 * A job the session has scheduled to wake itself (a `ScheduleWakeup` or `CronCreate`), as the SDK lists them at the end
 * of each turn (the `Stop` hook's `session_crons`).
 */
export interface SessionJob {
  /** The SDK's id for the job: what `CronDelete` takes. */
  readonly id: string
  /** Its 5-field cron expression: a one-off job's names its minute. */
  readonly schedule: string
  readonly recurring: boolean
  /** The prompt it wakes the agent with. */
  readonly prompt: string
}

/** A compaction's summary, as the `PostCompact` hook gives it (`docs/sdk-notes.md` §5). */
export interface CompactSummary {
  readonly trigger: CompactionTrigger
  /** The summary it wrote, as is: its `<analysis>` and `<summary>` blocks. */
  readonly summary: string
}

/** A `Bash` call about to run, as the session's `PreToolUse` hook tells it (`docs/sdk-notes.md` §14). */
export interface BashCallStarting {
  /** The call's `tool_use` id, a subagent's call's too. */
  readonly toolUseId: string
  /** The folder the command runs in: the session's, or a subagent's (its worktree, for one isolated in one). */
  readonly cwd: string
  readonly command: string
}

/**
 * A call to Glade's `request_access` tool about to run, as the session's `PreToolUse` hook tells it (#450): the tool's
 * own handler isn't told which call it answers, or whose.
 */
export interface AccessCallStarting {
  /** The call's `tool_use` id. */
  readonly toolUseId: string
  /** The SDK's id for the subagent making the call; null for the agent's own. */
  readonly agentId: string | null
  /** The call's input, as the model sent it. */
  readonly input: ToolInput
}

/**
 * A `Bash` call that has run, as the session's `PostToolUse` hook (it exited 0) or `PostToolUseFailure` hook (it
 * didn't) tells it, before its result goes back to the agent (`docs/sdk-notes.md` §15). A `Monitor` call's command
 * is told the same way: it runs in the sandbox too.
 */
export interface BashCallFinished {
  /** The call's `tool_use` id, a subagent's call's too. */
  readonly toolUseId: string
  readonly command: string
  /** What the call's result says: what the command printed, or, for one that failed, the error Claude Code gives. */
  readonly output: string
  /** Whether it failed (`PostToolUseFailure`): it exited non-zero, or couldn't run at all. */
  readonly failed: boolean
  /** Aborted when the SDK gives up on the hook, e.g. on an interrupt. */
  readonly signal: AbortSignal
}

/** What the host tells the agent about a `Bash` call that has run (`SessionHooks.onBashFinished`). */
export interface BashFinishedAnswer {
  /**
   * Added to what the agent reads of the call's result (`additionalContext`), e.g. that the folder it was blocked from
   * is now allowed and it can run the command again; null to add nothing.
   */
  readonly context: string | null
}

/**
 * What the session tells the host as it runs, through Claude Code's hooks (`docs/sdk-notes.md` §13 and §14), parsed at
 * the SDK boundary: the prompts that start its turns, the jobs it has scheduled, the summaries its compactions write
 * (§5) and the `Bash` calls about to run and run (§15).
 */
export interface SessionHooks {
  /**
   * A call to Glade's `request_access` tool is about to run (`PreToolUse`), the agent's own or a subagent's: which call
   * it is, and whose, for the card it may open (`docs/model-surface.md`).
   */
  readonly onAccessRequested?: (call: AccessCallStarting) => void
  /**
   * A `Bash` call has run, and its result waits until this resolves, however long that takes: the agent's turn holds
   * meanwhile (`docs/sdk-notes.md` §15). What it answers is added to what the agent reads of the result.
   */
  readonly onBashFinished?: (call: BashCallFinished) => Promise<BashFinishedAnswer>
  /**
   * A `Bash` call is about to run (`PreToolUse`): the call waits until this resolves, for a while at most, so the host
   * can see where things stand first. It never stops the call.
   */
  readonly onBashStarting?: (call: BashCallStarting) => Promise<void>
  /**
   * A prompt is about to start a turn (`UserPromptSubmit`): one of the host's messages, a background task's wake (its
   * `<task-notification>` blocks) or a scheduled job firing (its prompt). Answers whether it goes ahead.
   */
  readonly onPrompt: (prompt: string) => PromptVerdict
  /** A turn ended (`Stop`): the jobs the session has scheduled now. */
  readonly onTurnEnded: (jobs: readonly SessionJob[]) => void
  /** A compaction wrote its summary (`PostCompact`), just before the SDK reports it done (`compact_boundary`). */
  readonly onCompacted: (compaction: CompactSummary) => void
}

/** The folders a sandboxed command may read and write (the SDK's `sandbox.filesystem`), as absolute paths or `~/…`. */
export interface SandboxFilesystem {
  readonly denyRead?: readonly string[]
  /** Folders inside `denyRead` that stay readable. */
  readonly allowRead?: readonly string[]
  readonly allowWrite?: readonly string[]
  readonly denyWrite?: readonly string[]
}

/** The hosts a sandboxed command may reach without asking (the SDK's `sandbox.network`). */
export interface SandboxNetwork {
  readonly allowedDomains?: readonly string[]
}

/** A credential file or folder no sandboxed command may read, even in a folder it may (`sandbox.credentials`). */
export interface SandboxCredentialFile {
  readonly path: string
  readonly mode: 'deny'
}

/**
 * As much of the SDK's `sandbox` setting as Glade sets (`docs/sdk-notes.md` §15): Seatbelt around the agent's commands,
 * with the folders and hosts they may use.
 */
export interface SandboxSettings {
  readonly enabled: boolean
  /** Whether a sandbox that can't start fails every command rather than running it unsandboxed: true by default. */
  readonly failIfUnavailable?: boolean
  /** Whether a sandboxed command runs without asking, whatever the permission mode. */
  readonly autoAllowBashIfSandboxed?: boolean
  readonly filesystem?: SandboxFilesystem
  readonly network?: SandboxNetwork
  readonly credentials?: { readonly files?: readonly SandboxCredentialFile[] }
}

/**
 * Permission rules set as settings (`settings.permissions`), each a rule string such as `Read(//Users/me/notes/**)` or
 * `WebFetch(domain:registry.npmjs.org)`. Unlike `allowedTools`, a `WebFetch(domain:…)` rule here also lets the
 * sandbox's commands reach the host (`docs/sdk-notes.md` §15).
 */
export interface SettingsPermissions {
  readonly allow?: readonly string[]
  readonly ask?: readonly string[]
  readonly deny?: readonly string[]
  /** Folders the file tools may read and write, besides the session's own. */
  readonly additionalDirectories?: readonly string[]
}

/**
 * What Glade sets of a session's sandbox in its flag settings: at start, and on a live session with
 * `applyFlagSettings`. Each key given replaces what an earlier `applyFlagSettings` set for it (null clears it), but
 * never narrows what the session started with: the two are merged (`docs/sdk-notes.md` §15).
 */
export interface SandboxFlagSettings {
  readonly sandbox?: SandboxSettings | null
  readonly permissions?: SettingsPermissions | null
}

/** How to start one task's agent session. */
export interface AgentSessionOptions extends AgentSessionSettings {
  /** The folder the agent runs in: the workspace's root. */
  readonly cwd: string
  /** The SDK session to resume, or null to start a new one. */
  readonly resumeSessionId: string | null
  /** Appended to Claude Code's own system prompt. */
  readonly systemPromptAppend: string
  readonly mcpServers: AgentMcpServers
  /**
   * Variables added to the agent's environment, over the login shell's: the control endpoint's URL and token while
   * agents may control Glade, so scripts the agent runs can call it. None by default.
   */
  readonly env?: Readonly<Record<string, string>>
  /**
   * The permission rules the task was granted (Allow for this task): Claude Code lets the calls they cover through
   * without asking, in the ask mode. None by default.
   */
  readonly allowedRules?: readonly PermissionRule[]
  /**
   * The sandbox the session runs its commands in, and the permission rules set with it, as it starts: what a later
   * `applyFlagSettings` can add to but never take back (`docs/sdk-notes.md` §15). No sandbox by default.
   */
  readonly flagSettings?: SandboxFlagSettings
  /** Where the backend logs the session's agent process: the task's agent log. The backend's own by default. */
  readonly log?: Logger
  /**
   * Decides the tool calls Claude Code asks about, which it only does outside Allow all. Without one, every such call
   * is denied: there's no one to ask.
   */
  readonly onToolPermission?: ToolPermissionHandler
  /** What the session tells the host as it runs. Nothing is told by default, and every prompt goes ahead. */
  readonly hooks?: SessionHooks
}

/**
 * One live agent session: a long-lived SDK `query()` in streaming input mode. Its `messages` stream runs for the
 * session's whole life, across turns. It finishes when the session is closed and throws if the agent process fails.
 */
export interface AgentSession {
  /** Every message the SDK emits, unparsed: the runner parses each one at the boundary. Iterate it once. */
  readonly messages: AsyncIterable<unknown>
  /**
   * Gives the agent the user's next message, with the images pasted into it, in order (none by default). `uuid` comes
   * back on the turn's messages.
   */
  send(text: string, uuid: string, images?: readonly ImageData[]): void
  /**
   * Changes the session's settings, in order with the messages sent after it: only the ones that differ from the last
   * it was given. The model and effort apply to the turns after it, so change them between turns, never mid-turn; the
   * permission mode applies from the next tool call, so it can change at any time.
   */
  configure(settings: AgentSessionSettings): void
  /**
   * Changes the session's sandbox and the permission rules set with it, from its next tool call, mid-turn too, in order
   * with the messages and changes before it (the SDK's `applyFlagSettings`, `docs/sdk-notes.md` §15). Each key given
   * replaces what the last call set for it. Resolves once applied; rejects if the SDK refuses it.
   */
  applyFlagSettings(settings: SandboxFlagSettings): Promise<void>
  /** Interrupts the running turn, which then ends with an aborted result; the session stays alive. Stop uses it. */
  interrupt(): Promise<void>
  /**
   * Stops one of the session's tasks, such as a subagent or a background command, by the SDK's id for it
   * (`system/task_started`), leaving the turn running: the tool call that started it gets its result. Stop subagent,
   * and Stop on a running watcher, use it.
   */
  stopTask(sdkTaskId: string): Promise<void>
  /**
   * The SDK's account of the session's context (`getContextUsage({ detail: 'summary' })`, `docs/sdk-notes.md` §5),
   * unparsed: the runner reads where it compacts automatically from it. Rejects when the SDK can't say, e.g. once the
   * session has closed.
   */
  contextUsage(): Promise<unknown>
  /**
   * What Claude Code says about the account it runs on (the SDK's `accountInfo()`, `docs/sdk-notes.md` §1), unparsed:
   * the runner parses it at the boundary. Rejects if the agent process can't say, e.g. because it failed to start.
   */
  accountInfo(): Promise<unknown>
  /**
   * How much of the account's usage limits is used (the SDK's experimental
   * `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })`, `docs/sdk-notes.md` "Usage
   * limits"), unparsed: the account parses it at the boundary. Rejects when the SDK has no such call, or can't say.
   */
  usage(): Promise<unknown>
  /** Ends the session and its agent process. */
  close(): void
}

/** Starts agent sessions. */
export interface AgentBackend {
  start(options: AgentSessionOptions): AgentSession
}
