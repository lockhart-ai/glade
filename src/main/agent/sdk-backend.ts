// The real agent backend: a thin adapter from `AgentBackend` onto the Claude Agent SDK's `query()`. Everything Glade
// decides about a session (its folder, model, prompt, settings, permissions) is here; see `docs/sdk-notes.md`.
import {
  query,
  type CanUseTool,
  type HookCallback,
  type Options,
  type PermissionMode as SdkPermissionMode,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { createRequire } from 'node:module'
import { z } from 'zod'
import { CompactionTrigger, PermissionMode, type PermissionSuggestion, type ToolInput } from '../../shared/domain'
import { permissionRuleString } from '../../shared/permissions'
import { CONTROL_SERVER_NAME } from '../../shared/control'
import type { ImageData } from '../../shared/images'
import type { Environment } from '../login-env'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import { BOUNDED_TOOLS, isOutsideTool, OUTSIDE_TOOLS } from '../permissions/sandbox-classify'
import { permissionSuggestionSchema } from '../permissions/schema'
import { AsyncQueue } from './async-queue'
import { ChildTool, isChildTool } from './child-calls'
import { ACCESS_TOOL_NAME, gladeOwnServers, GLADE_SERVER } from './glade-tools'
import {
  PromptVerdict,
  ToolPermissionBehavior,
  type AgentBackend,
  type AgentSession,
  type AgentSessionOptions,
  type AgentSessionSettings,
  type BatchCall,
  type SandboxFlagSettings,
  type SandboxSettings,
  type SessionHooks,
  type SettingsPermissions,
  type SessionJob,
  type ToolPermissionAnswer,
  type ToolPermissionCall,
  type ToolPermissionHandler,
} from './backend'
import { stderrLogger } from './stderr-log'
import { userContent } from './user-content'

/** How to make the real backend. */
export interface SdkBackendOptions {
  /**
   * The environment Claude Code runs in: the user's login shell's (`resolveLoginEnv`), which a session waits for before
   * its agent process starts.
   */
  readonly env: Promise<Environment>
  /**
   * Where each agent process starting and closing, and a settings change the SDK refused, are logged, when the session
   * has no log of its own (`AgentSessionOptions.log`). Nothing by default.
   */
  readonly log?: Logger
  /** Glade's version, which each session's agent process names Glade by (`clientAppEnv`). */
  readonly version: string
  /**
   * Told the models the SDK offers, unparsed (`initializationResult().models`, `docs/sdk-notes.md` §4), each time a
   * session's agent process has started. Nothing by default.
   */
  readonly onModels?: (models: unknown) => void
}

/** The flag settings `applyFlagSettings` takes. */
type SdkFlagSettings = Parameters<Query['applyFlagSettings']>[0]

/** The SDK's `sandbox` setting. */
type SdkSandboxSettings = NonNullable<Options['sandbox']>

/** The SDK's settings `permissions`. */
type SdkSettingsPermissions = NonNullable<NonNullable<SdkFlagSettings['permissions']>>

/** Finds a module's file, as `require.resolve` does. */
export type ModuleResolver = (id: string) => string

/** The packaged app's asar archive: a single file, which Electron's `fs` reads into but `child_process` can't. */
const ASAR = /([\\/])app\.asar([\\/])/

/**
 * Where to run Claude Code's native binary from, if the SDK's own guess won't work; `undefined` leaves it to the SDK.
 *
 * The SDK finds the binary in its platform package (`@anthropic-ai/claude-agent-sdk-darwin-arm64`), which in the
 * packaged app is inside `app.asar`. Spawning a path in there fails with ENOTDIR, so this points at the unpacked copy
 * in `app.asar.unpacked` instead (electron-builder's `asarUnpack` puts it there).
 */
export function claudeCodeExecutable(
  resolve: ModuleResolver,
  platform: string = process.platform,
  arch: string = process.arch,
): string | undefined {
  const path = platformBinary(resolve, platform, arch)
  return path !== null && ASAR.test(path) ? unpacked(path) : undefined
}

/**
 * Claude Code's native binary, at a path it can be run from (the unpacked copy, in the packaged app), for running it
 * directly: its own login (`../account/login`, #409). Null with no platform package here.
 */
export function claudeCodeBinary(
  resolve: ModuleResolver = createRequire(import.meta.url).resolve,
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  const path = platformBinary(resolve, platform, arch)
  return path === null ? null : unpacked(path)
}

/** The binary in the SDK's platform package, wherever it is; null with none here. */
function platformBinary(resolve: ModuleResolver, platform: string, arch: string): string | null {
  try {
    return resolve(`@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude`)
  } catch {
    // No platform package here (or a variant, such as musl on Linux, that the SDK picks for itself).
    return null
  }
}

/** A path inside the packaged app's asar archive, moved to the unpacked copy of it; any other path as it is. */
function unpacked(path: string): string {
  return path.replace(ASAR, '$1app.asar.unpacked$2')
}

/**
 * What Glade adds to every session's environment. `CLAUDE_CODE_ENABLE_TODO_TOOLS` gives the session Claude Code's todo
 * tools (`TaskCreate`, `TaskUpdate`, …), which the Todos tab reads: the bundled Claude Code leaves them off for SDK
 * sessions on newer models (Opus 5.5, Sonnet 5), turning them on by default only for older ones
 * (`docs/sdk-notes.md` §10). The tools the agent schedules its own follow-ups with (background `Bash` and `Agent`,
 * `Monitor`, `ScheduleWakeup`, `CronCreate`) need nothing: SDK sessions have them already (§11).
 * `CLAUDE_CODE_STARTUP_FAILURE_RESULTS` has a session Claude Code can't start end with a result naming why
 * (`startup_failure_reason`), which the error card words, rather than only a failed process.
 */
export const SESSION_ENV: Environment = { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1' }

/**
 * What keeps Claude Code's task tools on in a session's flag settings, whatever a settings file says (#495,
 * `docs/sdk-notes.md` §16): `CLAUDE_CODE_ENABLE_TASKS` set false there gives the session `TodoWrite` instead.
 */
export const TASK_TOOLS_ENV: Environment = { CLAUDE_CODE_ENABLE_TASKS: 'true' }

/** What names Glade to the API, in the User-Agent of each session's requests: `glade/0.13.0`. */
export function clientAppEnv(version: string): Environment {
  return { CLAUDE_AGENT_SDK_CLIENT_APP: `glade/${version}` }
}

/**
 * The SDK permission mode each of Glade's runs in (`docs/sdk-notes.md` §9 and §15): the ask mode runs `default`, where
 * Claude Code asks `canUseTool` about every call its rules and the user's settings leave at "ask". Allow all bypasses
 * every check, so `canUseTool` is never called; in a `sandboxed` session it runs `acceptEdits` instead, since
 * `bypassPermissions` never asks and lets commands reach every host: edits and sandboxed commands go ahead, and crossing
 * the sandbox's bounds still asks.
 */
export function sdkPermissionMode(mode: PermissionMode, sandboxed = false): SdkPermissionMode {
  switch (mode) {
    case PermissionMode.AllowAll:
      return sandboxed ? 'acceptEdits' : 'bypassPermissions'
    case PermissionMode.AskBeforeEdits:
      return 'default'
  }
}

/** Whether a session runs its commands in the sandbox: it starts with one that's on. */
export function isSandboxed(options: Pick<AgentSessionOptions, 'flagSettings'>): boolean {
  return options.flagSettings?.sandbox?.enabled === true
}

/** What the agent is told when a call is denied because there was no one to ask about it. */
export const NO_ONE_TO_ASK = 'Glade had no way to ask the user about this tool call, so it did not run.'

/** What the agent is told when deciding a call failed. */
export const PERMISSION_FAILED = 'Glade could not ask the user about this tool call, so it did not run.'

/** The options `canUseTool` is called with. */
type CanUseToolOptions = Parameters<CanUseTool>[2]

/** The suggestions Glade knows the shape of; one it doesn't (a newer SDK's) is logged and left out. */
function knownSuggestions(suggestions: readonly unknown[], log: Logger): PermissionSuggestion[] {
  return suggestions.flatMap((suggestion) => {
    const parsed = permissionSuggestionSchema.safeParse(suggestion)
    if (parsed.success) return [parsed.data]
    log.warn('ignored a permission suggestion of a shape Glade does not know', { suggestion })
    return []
  })
}

/** A `canUseTool` call, parsed into Glade's terms. */
export function toolPermissionCall(
  toolName: string,
  input: ToolInput,
  options: CanUseToolOptions,
  log: Logger = SILENT_LOGGER,
): ToolPermissionCall {
  const { mcpServer } = options
  return {
    toolName,
    input,
    toolUseId: options.toolUseID,
    agentId: options.agentID ?? null,
    title: options.title ?? null,
    displayName: options.displayName ?? null,
    description: options.description ?? null,
    suggestions: knownSuggestions(options.suggestions ?? [], log),
    defaultToNo: options.defaultToNo === true,
    suppressAlwaysAllowRule: options.suppressAlwaysAllowRule === true,
    mcpServer: mcpServer === undefined ? null : { name: mcpServer.name, source: mcpServer.source },
    matchedAskRule: options.matchedAskRule !== undefined,
    blockedPath: options.blockedPath ?? null,
    decisionReason: options.decisionReason ?? null,
    signal: options.signal,
  }
}

/**
 * The SDK's result for Glade's answer. An allowed call runs with its input as it was; a person's decision is classified
 * as one (allow once, always allow, or reject), and one Glade made itself isn't. A rule granted with Allow for this
 * task goes to the session (`destination: 'session'`), never to a settings file: it applies to the calls after this one
 * at once, and dies with the agent's process, so Glade passes it as `allowedTools` whenever the task's session starts
 * (`docs/sdk-notes.md` §9).
 */
export function sdkPermissionResult(answer: ToolPermissionAnswer, input: ToolInput): PermissionResult {
  switch (answer.behavior) {
    case ToolPermissionBehavior.Allow: {
      const { rule } = answer
      if (rule !== undefined) {
        return {
          behavior: 'allow',
          updatedInput: { ...input },
          updatedPermissions: [{ type: 'addRules', rules: [{ ...rule }], behavior: 'allow', destination: 'session' }],
          decisionClassification: 'user_permanent',
        }
      }
      return {
        behavior: 'allow',
        updatedInput: { ...input },
        ...(answer.byUser ? { decisionClassification: 'user_temporary' } : {}),
      }
    }
    case ToolPermissionBehavior.Deny:
      return {
        behavior: 'deny',
        message: answer.message,
        ...(answer.byUser ? { decisionClassification: 'user_reject' } : {}),
      }
  }
}

/** `canUseTool` for a session: asks `handler` about each call, and denies it when there's none, or deciding fails. */
export function canUseToolFor(handler: ToolPermissionHandler | undefined, log: Logger): CanUseTool {
  return async (toolName, input, options) => {
    const call = toolPermissionCall(toolName, input, options, log)
    let answer: ToolPermissionAnswer
    try {
      answer =
        handler === undefined
          ? { behavior: ToolPermissionBehavior.Deny, message: NO_ONE_TO_ASK, byUser: false }
          : await handler(call)
    } catch (error) {
      log.error('failed to decide a tool call', { toolName, toolUseId: call.toolUseId, error })
      answer = { behavior: ToolPermissionBehavior.Deny, message: PERMISSION_FAILED, byUser: false }
    }
    return sdkPermissionResult(answer, input)
  }
}

/** Why a prompt was turned away, as the SDK says in its informational message; the model never sees it. */
export const BLOCKED_PROMPT_REASON = 'You stopped this watcher in Glade.'

const promptHookInput = z.looseObject({ prompt: z.string() })

const sessionJob = z.looseObject({ id: z.string(), schedule: z.string(), recurring: z.boolean(), prompt: z.string() })

const stopHookInput = z.looseObject({ session_crons: z.array(z.unknown()).optional().catch(undefined) })

/** What a `Stop` hook says of the turn's end, as far as holding it reads: whether it was held before, and whose it is. */
const turnEndingInput = z.looseObject({
  stop_hook_active: z.boolean().optional().catch(undefined),
  agent_id: z.string().optional().catch(undefined),
})

const postCompactHookInput = z.looseObject({ trigger: z.enum(CompactionTrigger), compact_summary: z.string() })

/** The jobs a `Stop` hook lists, skipping any of a shape Glade doesn't know. */
function sessionJobs(input: unknown, log: Logger): SessionJob[] {
  const parsed = stopHookInput.safeParse(input)
  const listed = parsed.success ? (parsed.data.session_crons ?? []) : []
  return listed.flatMap((raw) => {
    const job = sessionJob.safeParse(raw)
    if (job.success) {
      const { id, schedule, recurring, prompt } = job.data
      return [{ id, schedule, recurring, prompt }]
    }
    log.warn('ignored a scheduled job of a shape Glade does not know', { problem: job.error.message })
    return []
  })
}

const bashHookInput = z.looseObject({
  tool_use_id: z.string(),
  cwd: z.string(),
  tool_input: z.looseObject({ command: z.string() }),
})

/**
 * The longest a `Bash` call waits for the host's `onBashStarting` before it runs anyway: the host reads git then, which
 * is quick, but must never hold the agent up for long.
 */
export const BASH_HOOK_TIMEOUT_MS = 5_000

/** What a subagent's call to one of Glade's own tools is refused with (#366). */
export const SUBAGENT_TOOL_REFUSAL =
  "Only the main agent can use Glade's tools. Report what you have to the agent that started you instead."

/**
 * Glade's own in-process MCP servers, whose tools a subagent must never call: `glade` (`docs/model-surface.md`), and
 * `glade-control` (P13-01), the control API that lists, reads, changes, messages and deletes Glade's tasks. Neither is
 * given a restricted tool set of its own to hand to subagents, so without this guard a subagent inherits both, same as
 * the main agent (`docs/sdk-notes.md`, "Subagents").
 */
function isGladeServer(name: string): boolean {
  return name === GLADE_SERVER || name === CONTROL_SERVER_NAME
}

const preToolUseInput = z.looseObject({
  tool_name: z.string(),
  tool_use_id: z.string().optional(),
  tool_input: z.record(z.string(), z.unknown()).optional().catch(undefined),
  agent_id: z.string().optional(),
  mcp_server: z.looseObject({ name: z.string(), source: z.string() }).optional(),
})

/**
 * A `PreToolUse` hook (`docs/sdk-notes.md` §9) that refuses a subagent's call to any tool on one of Glade's own MCP
 * servers, whatever the tool: the only reliable place to catch every one, present and future tools included (#366).
 *
 * `canUseTool` can't do this job. `glade`'s tools are in `allowedTools` (below), a server-wide rule Claude Code lets
 * through before `canUseTool` is ever asked; and `bypassPermissions` (Allow all) never calls `canUseTool` at all, for
 * any tool, `glade-control`'s included. A `PreToolUse` hook fires for every tool call regardless of permission mode,
 * and is asked before `canUseTool` would be, so denying here means no permission card and no question card ever
 * shows: the call fails outright, with a message the model can act on.
 *
 * One tool is let through: `glade`'s `request_access` (#450, `docs/model-surface.md`). A subagent's commands are
 * sandboxed as the agent's are, so it asks for a folder the same way, and its card names it. The hook tells
 * `onAccessRequested` of every call to that tool, the main agent's too: which call it is and whose, which the tool's
 * handler isn't told.
 *
 * Trusts `mcp_server.source`, not the tool's name or its server's name: only `'sdk'` means an in-process server the
 * SDK host (Glade) registered, which nothing configured can impersonate; any other source is a server from
 * configuration, which could call itself `glade` too (`docs/sdk-notes.md` §9).
 */
export function subagentGladeToolGuard(
  log: Logger = SILENT_LOGGER,
  onAccessRequested?: SessionHooks['onAccessRequested'],
): HookCallback {
  return (input) => {
    const parsed = preToolUseInput.safeParse(input)
    if (!parsed.success) return Promise.resolve({})
    const { agent_id: agentId, mcp_server: mcpServer, tool_name: toolName } = parsed.data
    if (mcpServer === undefined) return Promise.resolve({})
    if (mcpServer.source !== 'sdk' || !isGladeServer(mcpServer.name)) return Promise.resolve({})
    if (mcpServer.name === GLADE_SERVER && toolName === ACCESS_TOOL_NAME) {
      const { tool_use_id: toolUseId, tool_input: toolInput } = parsed.data
      try {
        if (toolUseId !== undefined) {
          onAccessRequested?.({ toolUseId, agentId: agentId ?? null, input: toolInput ?? {} })
        }
      } catch (error) {
        log.error('failed to note a request_access call', { error })
      }
      return Promise.resolve({})
    }
    if (agentId === undefined) return Promise.resolve({})
    log.info("refused a subagent's call to one of Glade's own tools", { toolName, server: mcpServer.name, agentId })
    return Promise.resolve({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: SUBAGENT_TOOL_REFUSAL,
      },
    })
  }
}

/** What the agent is told when Glade couldn't check a call against the sandbox's bounds: it doesn't run. */
export const SANDBOX_CHECK_FAILED = 'Glade could not check this tool call against the sandbox, so it did not run.'

/**
 * The tools the agent sandbox bounds (`BOUNDED_TOOLS`), and the ones that reach outside it altogether (`OUTSIDE_TOOLS`:
 * every MCP tool, `SendMessage` and `RemoteTrigger`, #515), as a hook matcher.
 */
export const SANDBOX_TOOLS = [...BOUNDED_TOOLS, ...OUTSIDE_TOOLS].join('|')

const sandboxedToolInput = z.looseObject({
  tool_name: z.string(),
  tool_use_id: z.string(),
  tool_input: z.record(z.string(), z.unknown()).optional().catch(undefined),
  agent_id: z.string().optional(),
  // Of a shape Glade doesn't know, it's as if the hook hadn't said: the server is then one Glade can't vouch for.
  mcp_server: z.looseObject({ name: z.string(), source: z.string() }).optional().catch(undefined),
})

/** A `PreToolUse` hook's answer that settles a call: it runs, or it doesn't, with what the agent is told. */
function hookDecision(decision: 'allow' | 'deny', reason?: string): Awaited<ReturnType<HookCallback>> {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      ...(reason === undefined ? {} : { permissionDecisionReason: reason }),
    },
  }
}

/**
 * The `PreToolUse` hook that holds a sandboxed session's file tools, `WebFetch`, `Bash` and `Monitor` to the sandbox's
 * bounds (#514, `docs/sdk-notes.md` §15), and its MCP tools, `SendMessage` and `RemoteTrigger` to what's granted
 * outside it (#515): each such call says which server its tool is on (`mcp_server`), as the SDK names it.
 * A `PreToolUse` hook runs in every permission mode and before Claude Code
 * matches a single rule, so this is where Glade decides a call that crosses the bounds, whatever the user's, the
 * project's or the local settings would allow: it asks the host (`SessionHooks.onToolStarting`), waits on its answer
 * however long that takes (a card may wait on the user), and returns it as the hook's own decision. `deny` stops the
 * call. `allow` lets it run; if Claude Code still asks about it (an ask rule of its own, or its check of the files
 * that run code), the host answers the same again. Nothing is returned for a call the host leaves alone: Claude Code
 * decides it as it always has.
 *
 * It answers `allow` or `deny`, never `ask`. An `ask` should hand the call to `canUseTool` whatever the rules say (the
 * bundled CLI's code reads that way), but that isn't probed, and a call that slipped past would run unasked: deciding
 * here doesn't depend on it.
 *
 * Fails closed: input of a shape Glade doesn't know, or a host that throws, denies the call.
 */
export function sandboxToolGuard(
  onToolStarting: NonNullable<SessionHooks['onToolStarting']>,
  log: Logger = SILENT_LOGGER,
): HookCallback {
  const bounded = new Set(BOUNDED_TOOLS)
  return async (input, _toolUseId, { signal }) => {
    const parsed = sandboxedToolInput.safeParse(input)
    if (!parsed.success) {
      log.error('refused a tool call whose hook input Glade does not know', { problem: parsed.error.message })
      return hookDecision('deny', SANDBOX_CHECK_FAILED)
    }
    const { tool_name: toolName, tool_use_id: toolUseId, tool_input: toolInput, agent_id: agentId } = parsed.data
    // The matcher may match more than the names it lists: only these are the host's to decide.
    if (!bounded.has(toolName) && !isOutsideTool(toolName)) return {}
    const { mcp_server: mcpServer } = parsed.data
    try {
      const decision = await onToolStarting({
        toolName,
        input: toolInput ?? {},
        mcpServer: mcpServer === undefined ? null : { name: mcpServer.name, source: mcpServer.source },
        toolUseId,
        agentId: agentId ?? null,
        signal,
      })
      if (decision === null) return {}
      switch (decision.behavior) {
        case ToolPermissionBehavior.Allow:
          return hookDecision('allow')
        case ToolPermissionBehavior.Deny:
          return hookDecision('deny', decision.message)
      }
    } catch (error) {
      log.error('failed to check a tool call against the sandbox', { toolName, toolUseId, error })
      return hookDecision('deny', SANDBOX_CHECK_FAILED)
    }
  }
}

/** The tools of Claude Code's own that make something a todo can hold, as a hook matcher (`ChildTool`). */
export const CHILD_TOOLS = Object.values(ChildTool).join('|')

const childCallInput = z.looseObject({
  tool_name: z.string(),
  tool_use_id: z.string(),
  tool_input: z.record(z.string(), z.unknown()),
  agent_id: z.string().optional(),
})

/**
 * The `PreToolUse` hook on the tools that make something a todo can hold (`docs/sdk-notes.md` §16, #495): puts each
 * call of the agent's own to the host (`SessionHooks.onChildStarting`), and hands the tool the input it answers with,
 * the whole of it, in place of the model's (`updatedInput`): the call's marker for its todo taken off, so nothing the
 * SDK says of the call afterwards carries it.
 *
 * It never decides the call: an `allow` from a hook skips the permission check, and the ask mode would run the call
 * without asking. With no decision, Claude Code asks about the new input as it would have about the old.
 *
 * A subagent's call (one with an `agent_id`) is left alone, at once: what a subagent makes follows its todo. So is
 * anything this can't read, and a call the host fails on: the call runs as the model wrote it.
 */
export function childCallHook(
  onChildStarting: NonNullable<SessionHooks['onChildStarting']>,
  log: Logger = SILENT_LOGGER,
): HookCallback {
  return async (input) => {
    const parsed = childCallInput.safeParse(input)
    if (!parsed.success || parsed.data.agent_id !== undefined) return {}
    const { tool_name: toolName, tool_use_id: toolUseId, tool_input: toolInput } = parsed.data
    // The matcher may match more than the names it lists (another server's `mcp__x__Bash`): only these make a child.
    if (!isChildTool(toolName)) return {}
    try {
      const updated = await onChildStarting({ toolName, input: toolInput, toolUseId })
      if (updated === null) return {}
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...updated } } }
    } catch (error) {
      log.error('failed to read the todo a call names', { toolName, toolUseId, error })
      return {}
    }
  }
}

const toolBatchInput = z.looseObject({
  tool_calls: z.array(z.unknown()),
  agent_id: z.string().optional(),
})

const batchCallInput = z.looseObject({
  tool_name: z.string(),
  tool_use_id: z.string(),
  tool_input: z.record(z.string(), z.unknown()).optional().catch(undefined),
  tool_response: z.unknown().optional(),
})

/** A `Bash` call's result as some hooks give it: what it printed, apart. */
const commandResponse = z.looseObject({
  stdout: z.string().optional().catch(undefined),
  stderr: z.string().optional().catch(undefined),
})

/** A result given as content blocks: its text ones. */
const textBlocks = z.array(z.looseObject({ type: z.literal('text'), text: z.string() }))

/**
 * What a call's result says, as text, from what a `PostToolBatch` hook gives of it (`tool_response`): the text the
 * agent reads, a command's output, or a result's text blocks. Empty for anything else.
 */
export function responseText(response: unknown): string {
  if (typeof response === 'string') return response
  const blocks = textBlocks.safeParse(response)
  if (blocks.success) return blocks.data.map(({ text }) => text).join('\n')
  const command = commandResponse.safeParse(response)
  if (!command.success) return ''
  return [command.data.stdout ?? '', command.data.stderr ?? ''].filter(Boolean).join('\n')
}

/**
 * The `PostToolBatch` hook (`docs/sdk-notes.md` §16, #495): once the calls of one of the agent's own messages have all
 * run, tells the host of them (`SessionHooks.onBatchFinished`) and adds what it answers to what the agent reads with
 * their results (`additionalContext`), before its next step.
 *
 * It fires for a subagent's messages too, with the subagent's `agent_id`, and context answered to one of those goes to
 * that subagent: those are ignored, at once. A call of a shape Glade doesn't know is left out; a host that fails adds
 * nothing.
 */
export function toolBatchHook(
  onBatchFinished: NonNullable<SessionHooks['onBatchFinished']>,
  log: Logger = SILENT_LOGGER,
): HookCallback {
  return async (input) => {
    const parsed = toolBatchInput.safeParse(input)
    if (!parsed.success || parsed.data.agent_id !== undefined) return {}
    const calls = parsed.data.tool_calls.flatMap((raw): BatchCall[] => {
      const call = batchCallInput.safeParse(raw)
      if (!call.success) return []
      const { tool_name: toolName, tool_use_id: toolUseId, tool_input: toolInput, tool_response: response } = call.data
      return [{ toolName, toolUseId, input: toolInput ?? {}, output: responseText(response) }]
    })
    try {
      const context = await onBatchFinished({ calls })
      if (context === null) return {}
      return { hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: context } }
    } catch (error) {
      log.error("failed to note a message's tool calls", { error })
      return {}
    }
  }
}

/**
 * The SDK hooks every session gets (`docs/sdk-notes.md` §9, §13 and §14): a subagent's call to one of Glade's own
 * tools is always refused (`subagentGladeToolGuard`, above), whether or not the session tells the runner anything
 * else. When it does (`hooks`), the rest follow: each prompt that's about to start a turn (`UserPromptSubmit`), which
 * it can turn away, the jobs the session has scheduled at the end of each turn (`Stop`), the summary each compaction
 * writes (`PostCompact`, §5), and each `Bash` call about to run (`PreToolUse`), which waits for the host a while at
 * most. A hook that fails lets the prompt or call through, and tells nothing. When the session wants to hear of each
 * `Bash` call that has run (`onBashFinished`, §15), its `PostToolUse` and `PostToolUseFailure` hooks tell it, of
 * `Monitor`'s commands too, and the call's result waits for the answer. A sandboxed session's calls to the tools the
 * sandbox bounds are decided before they run (`onToolStarting`, `sandboxToolGuard`): that hook fails closed.
 *
 * A session with the todo hub on (#495, §16) has three more: its own calls to the tools that make something a todo can
 * hold run with the input the host hands back (`onChildStarting`, `childCallHook`), the host is told of each of its
 * messages' calls once they've run and can tell the agent something with their results (`onBatchFinished`,
 * `toolBatchHook`), and the `Stop` hook holds the end of a turn while the host says why it can't end
 * (`onTurnEnding`). Without those, a session's hooks are exactly what they were.
 */
export function sdkHooks(
  hooks: SessionHooks | undefined,
  log: Logger = SILENT_LOGGER,
  bashTimeoutMs: number = BASH_HOOK_TIMEOUT_MS,
): NonNullable<Options['hooks']> {
  const preToolUse: NonNullable<Options['hooks']>['PreToolUse'] = [
    { hooks: [subagentGladeToolGuard(log, hooks?.onAccessRequested)] },
  ]
  if (hooks === undefined) return { PreToolUse: preToolUse }
  const { onToolStarting } = hooks
  if (onToolStarting !== undefined) {
    // As long as a timer allows: a card may wait on the user, and a hook that timed out would let its call through.
    preToolUse.push({
      matcher: SANDBOX_TOOLS,
      hooks: [sandboxToolGuard(onToolStarting, log)],
      timeout: BASH_FINISHED_TIMEOUT_S,
    })
  }
  const onPrompt: HookCallback = (input) => {
    const parsed = promptHookInput.safeParse(input)
    if (!parsed.success) return Promise.resolve({})
    try {
      if (hooks.onPrompt(parsed.data.prompt) === PromptVerdict.Block) {
        log.info('prompt turned away', { prompt: parsed.data.prompt.slice(0, 200) })
        return Promise.resolve({ decision: 'block', reason: BLOCKED_PROMPT_REASON })
      }
    } catch (error) {
      log.error('failed to check a prompt', { error })
    }
    return Promise.resolve({})
  }
  const { onTurnEnding } = hooks
  const onStop: HookCallback = async (input) => {
    try {
      hooks.onTurnEnded(sessionJobs(input, log))
    } catch (error) {
      log.error('failed to read the scheduled jobs', { error })
    }
    if (onTurnEnding === undefined) return {}
    const ending = turnEndingInput.safeParse(input)
    // Only the agent's own turn is ever held.
    if (!ending.success || ending.data.agent_id !== undefined) return {}
    const held = ending.data.stop_hook_active === true
    try {
      const reason = await onTurnEnding({ held })
      if (reason === null) return {}
      log.info('turn end held', { held })
      return { decision: 'block', reason }
    } catch (error) {
      log.error('failed to decide whether a turn may end', { error })
      return {}
    }
  }
  const onPostCompact: HookCallback = (input) => {
    const parsed = postCompactHookInput.safeParse(input)
    if (!parsed.success) {
      log.warn('ignored a compaction summary of a shape Glade does not know', { problem: parsed.error.message })
      return Promise.resolve({})
    }
    try {
      hooks.onCompacted({ trigger: parsed.data.trigger, summary: parsed.data.compact_summary })
    } catch (error) {
      log.error('failed to keep a compaction summary', { error })
    }
    return Promise.resolve({})
  }
  const { onBashStarting } = hooks
  const onBash: HookCallback = async (input) => {
    const parsed = bashHookInput.safeParse(input)
    if (!parsed.success || onBashStarting === undefined) return {}
    const { tool_use_id: toolUseId, cwd, tool_input: toolInput } = parsed.data
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout')
      }, bashTimeoutMs)
    })
    try {
      const done = onBashStarting({ toolUseId, cwd, command: toolInput.command }).then(() => 'done' as const)
      if ((await Promise.race([done, timeout])) === 'timeout') {
        log.warn('ran a Bash call without waiting any longer for its hook', { toolUseId })
      }
    } catch (error) {
      log.error('failed to note a Bash call', { error })
    } finally {
      clearTimeout(timer)
    }
    return {}
  }
  if (onBashStarting !== undefined) preToolUse.push({ matcher: 'Bash', hooks: [onBash] })
  const { onBashFinished, onChildStarting, onBatchFinished } = hooks
  if (onChildStarting !== undefined) {
    preToolUse.push({ matcher: CHILD_TOOLS, hooks: [childCallHook(onChildStarting, log)] })
  }
  return {
    PreToolUse: preToolUse,
    UserPromptSubmit: [{ hooks: [onPrompt] }],
    Stop: [{ hooks: [onStop] }],
    PostCompact: [{ hooks: [onPostCompact] }],
    ...(onBatchFinished === undefined ? {} : { PostToolBatch: [{ hooks: [toolBatchHook(onBatchFinished, log)] }] }),
    ...(onBashFinished === undefined
      ? {}
      : {
          PostToolUse: [
            {
              matcher: COMMAND_TOOLS,
              hooks: [bashFinishedHook(onBashFinished, log)],
              timeout: BASH_FINISHED_TIMEOUT_S,
            },
          ],
          PostToolUseFailure: [
            {
              matcher: COMMAND_TOOLS,
              hooks: [bashFinishedHook(onBashFinished, log)],
              timeout: BASH_FINISHED_TIMEOUT_S,
            },
          ],
        }),
  }
}

/**
 * The tools that run a shell command, as a hook matcher: `Bash`, and `Monitor`, whose command runs in the sandbox too
 * (a `Monitor` call that opens a socket instead has no command, and isn't told).
 */
export const COMMAND_TOOLS = 'Bash|Monitor'

/**
 * How long, in seconds, a `Bash` call's result waits for the host's `onBashFinished`: as long as a timer can, about 24.8
 * days, since a card may wait on the user that long. Without one, Claude Code gives a hook callback 10 minutes, then
 * hands the agent the result and ignores the hook's late answer (`docs/sdk-notes.md` §15).
 */
export const BASH_FINISHED_TIMEOUT_S = Math.floor((2 ** 31 - 1) / 1000)

const bashFinishedInput = z.discriminatedUnion('hook_event_name', [
  z.looseObject({
    hook_event_name: z.literal('PostToolUse'),
    tool_use_id: z.string(),
    tool_input: z.looseObject({ command: z.string() }),
    tool_response: z
      .looseObject({ stdout: z.string().optional().catch(undefined), stderr: z.string().optional().catch(undefined) })
      .optional()
      .catch(undefined),
  }),
  z.looseObject({
    hook_event_name: z.literal('PostToolUseFailure'),
    tool_use_id: z.string(),
    tool_input: z.looseObject({ command: z.string() }),
    error: z.string(),
  }),
])

/**
 * The `PostToolUse` or `PostToolUseFailure` hook on `Bash` (`docs/sdk-notes.md` §15): a command that exited 0 fires
 * the first, one that didn't (most a sandbox blocked) the second. Tells the host the call has run and waits for it,
 * however long, while the call's result and the turn wait; then adds what it answered to what the agent reads. A hook
 * that fails, or input of a shape Glade doesn't know, adds nothing.
 */
function bashFinishedHook(onBashFinished: NonNullable<SessionHooks['onBashFinished']>, log: Logger): HookCallback {
  return async (input, _toolUseId, { signal }) => {
    const parsed = bashFinishedInput.safeParse(input)
    if (!parsed.success) return {}
    const finished = parsed.data
    const failed = finished.hook_event_name === 'PostToolUseFailure'
    const output = failed
      ? finished.error
      : [finished.tool_response?.stdout ?? '', finished.tool_response?.stderr ?? ''].filter(Boolean).join('\n')
    try {
      const { context } = await onBashFinished({
        toolUseId: finished.tool_use_id,
        command: finished.tool_input.command,
        output,
        failed,
        signal,
      })
      if (context === null) return {}
      return { hookSpecificOutput: { hookEventName: finished.hook_event_name, additionalContext: context } }
    } catch (error) {
      log.error('failed to note a finished Bash call', { toolUseId: finished.tool_use_id, error })
      return {}
    }
  }
}

/** The tools no session of Glade's is offered: Claude Code's own asking tool, which has no UI here. */
export const DISALLOWED_TOOLS: readonly string[] = ['AskUserQuestion']

/**
 * The tools a sandboxed session isn't offered either (#514): `EnterWorktree` moves the session's working folder into
 * another worktree of the repository, outside the workspace root, where Claude Code's file tools would follow while
 * Glade's bounds stayed with the root; `ExitWorktree` is its other half.
 */
export const SANDBOX_DISALLOWED_TOOLS: readonly string[] = ['EnterWorktree', 'ExitWorktree']

/** The SDK options for a session that runs in `env`. */
export function sdkOptions(
  options: AgentSessionOptions,
  env: Environment,
  resolve: ModuleResolver = createRequire(import.meta.url).resolve,
): Options {
  const executable = claudeCodeExecutable(resolve)
  const { sandbox, permissions } = options.flagSettings ?? {}
  const sandboxed = isSandboxed(options)
  return {
    ...(executable === undefined ? {} : { pathToClaudeCodeExecutable: executable }),
    // The whole environment, since it replaces Glade's own: opened from Finder, that has launchd's bare PATH. A copy,
    // since the SDK adds to it. No credentials of Glade's: the bundled Claude Code binary finds the user's login itself.
    env: { ...env, ...options.env, ...SESSION_ENV },
    cwd: options.cwd,
    model: options.model,
    effort: options.effort,
    ...(options.resumeSessionId === null ? {} : { resume: options.resumeSessionId }),
    // Allow all bypasses every check; the ask mode asks `canUseTool` (docs/decisions.md, "Per-call permission review").
    // Bypassing stays allowed whatever the mode starts as, so a live session can switch into it (docs/sdk-notes.md §9).
    // A sandboxed session never bypasses: its Allow all is `acceptEdits`, so crossing the sandbox's bounds asks (§15).
    permissionMode: sdkPermissionMode(options.permissionMode, sandboxed),
    ...(sandboxed ? {} : { allowDangerouslySkipPermissions: true }),
    canUseTool: canUseToolFor(options.onToolPermission, options.log ?? SILENT_LOGGER),
    // Glade's own tools never ask: Claude Code lets them through before `canUseTool` is called. Only `glade`'s: another
    // in-process server's (`glade-control`) go to `canUseTool`, which decides them. Nor do the calls the task's granted
    // rules cover (Allow for this task), which Claude Code matches itself, compound commands included.
    allowedTools: [
      ...gladeOwnServers(options.mcpServers).map((name) => `mcp__${name}`),
      ...(options.allowedRules ?? []).map(permissionRuleString),
    ],
    // Behave like `claude` run in the workspace root: the workspace's CLAUDE.md, and the user's own settings.
    settingSources: ['user', 'project', 'local'],
    // A `glade-control` server in the user's own config (the command Settings › Control gives, run in the workspace)
    // would join the in-process one under the same name, each tool twice, calling Glade over HTTP as no task at all.
    // Denied by name, it's left out, and the in-process one, which the denylist doesn't reach, is the only one
    // (docs/sdk-notes.md §12).
    // With the todo hub on, Claude Code's task tools stay on too: set here, in the flag settings, the switch outranks
    // the user's, the project's and the local settings files, any of which could swap them for `TodoWrite`, whose
    // items have no id to file under (docs/sdk-notes.md §16).
    settings: {
      deniedMcpServers: [{ serverName: CONTROL_SERVER_NAME }],
      ...(permissions === undefined || permissions === null ? {} : { permissions: sdkPermissions(permissions) }),
      ...(options.keepTaskTools === true ? { env: { ...TASK_TOOLS_ENV } } : {}),
    },
    // The sandbox the session's commands run in, as it starts: what `applyFlagSettings` adds to later, and can't take
    // back (docs/sdk-notes.md §15). None without one.
    ...(sandbox === undefined || sandbox === null ? {} : { sandbox: sdkSandbox(sandbox) }),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: options.systemPromptAppend },
    mcpServers: { ...options.mcpServers },
    // Questions go through Glade's own `ask`, which shows them on a card; Claude Code's own asking tool has no UI here.
    // A sandboxed session can't move into another worktree either: its sandbox is bounded by the folder it started in.
    disallowedTools: sandboxed ? [...DISALLOWED_TOOLS, ...SANDBOX_DISALLOWED_TOOLS] : [...DISALLOWED_TOOLS],
    // A subagent's own text too, not just its tool calls: the Subagents tab shows the last thing each one said.
    forwardSubagentText: true,
    // A running subagent's one-line summary of what it's doing now, about every 30 seconds, from a small fork of its
    // conversation: the line under its name in the Subagents tab (docs/sdk-notes.md, "Subagents").
    agentProgressSummaries: true,
    // What the Claude Code process prints to its error output goes to the task's log, within limits (docs/logs.md).
    stderr: stderrLogger(options.log ?? SILENT_LOGGER),
    // Glade stops each background subagent and watcher from its own tab (`stopTask`), so Stop on a turn ends only the
    // turn. Without this, the SDK fails closed and an interrupt kills every background subagent (docs/sdk-notes.md §7).
    perTaskStopAffordance: true,
    // Always given: a subagent's call to one of Glade's own tools is refused whether or not the session tells the
    // runner anything else (#366). What the session's watchers do, when it does, is in here too (the Watchers tab,
    // docs/sdk-notes.md §13).
    hooks: sdkHooks(options.hooks, options.log ?? SILENT_LOGGER),
  }
}

/** The SDK's sandbox setting for Glade's (`docs/sdk-notes.md` §15), its lists copied, since the SDK may change them. */
export function sdkSandbox(settings: SandboxSettings): SdkSandboxSettings {
  const { filesystem, network, credentials, ignoreViolations } = settings
  return {
    enabled: settings.enabled,
    failIfUnavailable: settings.failIfUnavailable,
    autoAllowBashIfSandboxed: settings.autoAllowBashIfSandboxed,
    filesystem:
      filesystem === undefined
        ? undefined
        : {
            denyRead: copy(filesystem.denyRead),
            allowRead: copy(filesystem.allowRead),
            allowWrite: copy(filesystem.allowWrite),
            denyWrite: copy(filesystem.denyWrite),
            disabled: filesystem.disabled,
          },
    network:
      network === undefined
        ? undefined
        : {
            allowedDomains: copy(network.allowedDomains),
            allowLocalBinding: network.allowLocalBinding,
            allowAllUnixSockets: network.allowAllUnixSockets,
            allowUnixSockets: copy(network.allowUnixSockets),
          },
    credentials:
      credentials === undefined
        ? undefined
        : {
            files: credentials.files?.map(({ path, mode }) => ({ path, mode })),
            envVars: credentials.envVars?.map(({ name, mode }) => ({ name, mode })),
          },
    allowAppleEvents: settings.allowAppleEvents,
    enableWeakerNestedSandbox: settings.enableWeakerNestedSandbox,
    enableWeakerNetworkIsolation: settings.enableWeakerNetworkIsolation,
    ignoreViolations:
      ignoreViolations === undefined
        ? undefined
        : Object.fromEntries(Object.entries(ignoreViolations).map(([pattern, denials]) => [pattern, [...denials]])),
  }
}

/** The SDK's settings permissions for Glade's rules (`docs/sdk-notes.md` §15). */
export function sdkPermissions(permissions: SettingsPermissions): SdkSettingsPermissions {
  return {
    allow: copy(permissions.allow),
    ask: copy(permissions.ask),
    deny: copy(permissions.deny),
    additionalDirectories: copy(permissions.additionalDirectories),
  }
}

/** The flag settings `applyFlagSettings` takes for Glade's: only the keys given, a null one cleared. */
export function sdkFlagSettings({ sandbox, permissions }: SandboxFlagSettings): SdkFlagSettings {
  return {
    ...(sandbox === undefined ? {} : { sandbox: sandbox === null ? null : sdkSandbox(sandbox) }),
    ...(permissions === undefined ? {} : { permissions: permissions === null ? null : sdkPermissions(permissions) }),
  }
}

/** A copy of a list, which the SDK may change; undefined for none, which leaves its key out of the JSON it sends. */
function copy(list: readonly string[] | undefined): string[] | undefined {
  return list === undefined ? undefined : [...list]
}

/** The SDK user message for the user's next message and its images, stamped as typed by a person. */
export function userMessage(text: string, uuid: string, images: readonly ImageData[] = []): SDKUserMessage {
  return {
    type: 'user',
    uuid: uuid as SDKUserMessage['uuid'],
    parent_tool_use_id: null,
    origin: { kind: 'human' },
    message: { role: 'user', content: userContent(text, images) },
  }
}

/**
 * Starts each session as one long-lived `query()` in streaming input mode: its prompt is a queue the session pushes the
 * user's messages into, turn after turn. The `query()`, and with it the agent process, starts once `env` is known; a
 * session started before then takes messages and settings meanwhile, and delivers them in order once it runs.
 *
 * A settings change and the messages after it are delivered in order: the next message waits for `setModel` and
 * `applyFlagSettings` to finish (`docs/sdk-notes.md` §4), and for `setPermissionMode` when the permission mode changed
 * (§9), each only when what it sets changed. If the SDK refuses a change, the message still goes, on the settings the
 * session had. Once each session's process has started, the models the SDK offers go to `onModels`, if given.
 */
export function createSdkBackend({
  env,
  log: backendLog = SILENT_LOGGER,
  version,
  onModels,
}: SdkBackendOptions): AgentBackend {
  return {
    start(options): AgentSession {
      const log = options.log ?? backendLog
      const input = new AsyncQueue<SDKUserMessage>()
      const started: Promise<Query> = env.then((resolved) => {
        const sdk = sdkOptions({ ...options, log }, { ...resolved, ...clientAppEnv(version) })
        log.info('agent process starting', {
          executable: sdk.pathToClaudeCodeExecutable ?? null,
          cwd: options.cwd,
          model: options.model,
          effort: options.effort,
          permissionMode: options.permissionMode,
          resumeSessionId: options.resumeSessionId,
          mcpServers: Object.keys(options.mcpServers),
          allowedTools: sdk.allowedTools ?? [],
          PATH: resolved.PATH ?? null,
        })
        return query({ prompt: input, options: sdk })
      })
      // The models the user's login offers, as the process reports them once it has started.
      if (onModels !== undefined) {
        started
          .then((session) => session.initializationResult())
          .then(({ models }) => {
            onModels(models)
          })
          .catch((error: unknown) => {
            log.warn("couldn't read the models the SDK offers", { error })
          })
      }
      // Everything asked of the session so far, in order.
      let queue = Promise.resolve()
      // The settings the session was last given: a change applies only what differs from them.
      let given: AgentSessionSettings = {
        model: options.model,
        effort: options.effort,
        permissionMode: options.permissionMode,
      }
      const then = (step: () => Promise<void> | void): void => {
        queue = queue.then(step)
      }
      return {
        messages: (async function* () {
          yield* await started
        })(),
        send(text, uuid, images) {
          then(() => {
            input.push(userMessage(text, uuid, images))
          })
        },
        configure(settings) {
          const before = given
          given = settings
          const { model, effort, permissionMode } = settings
          then(async () => {
            const session = await started
            if (model !== before.model || effort !== before.effort) {
              try {
                await session.setModel(model)
                await session.applyFlagSettings({ effortLevel: effort })
              } catch (error) {
                log.warn("the SDK refused the session's new settings", { model, effort, error })
              }
            }
            if (permissionMode !== before.permissionMode) {
              try {
                await session.setPermissionMode(sdkPermissionMode(permissionMode, isSandboxed(options)))
                log.info('permission mode changed', { permissionMode })
              } catch (error) {
                log.warn("the SDK refused the session's new permission mode", { permissionMode, error })
              }
            }
          })
        },
        applyFlagSettings(settings) {
          // In order with what was asked of the session before it; what comes after waits for it, refused or not.
          const applied = queue.then(async () => {
            const session = await started
            await session.applyFlagSettings(sdkFlagSettings(settings))
            log.info('sandbox settings changed', { settings })
          })
          queue = applied.catch((error: unknown) => {
            log.warn("the SDK refused the session's new sandbox settings", { settings, error })
          })
          return applied
        },
        async interrupt() {
          log.info('agent interrupted')
          await (await started).interrupt()
        },
        async stopTask(sdkTaskId) {
          log.info('agent task stopped', { sdkTaskId })
          await (await started).stopTask(sdkTaskId)
        },
        async contextUsage() {
          return (await started).getContextUsage({ detail: 'summary' })
        },
        async accountInfo() {
          return (await started).accountInfo()
        },
        async usage() {
          // Experimental (`docs/sdk-notes.md`, "Usage limits"): an SDK without it rejects, and the account keeps what
          // the rate limit events said.
          const session: Partial<Query> = await started
          const answer = session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.({ skipBehaviors: true })
          if (answer === undefined) throw new Error('This SDK has no usage call.')
          return answer
        },
        close() {
          log.info('agent process closing')
          then(() => {
            input.end()
          })
          void started.then((session) => {
            session.close()
          })
        },
      }
    },
  }
}
