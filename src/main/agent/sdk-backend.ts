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
import { PermissionMode, type PermissionSuggestion, type ToolInput } from '../../shared/domain'
import { permissionRuleString } from '../../shared/permissions'
import { CONTROL_SERVER_NAME } from '../../shared/control'
import type { ImageData } from '../../shared/images'
import type { Environment } from '../login-env'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import { permissionSuggestionSchema } from '../permissions/schema'
import { AsyncQueue } from './async-queue'
import { gladeOwnServers } from './glade-tools'
import {
  PromptVerdict,
  ToolPermissionBehavior,
  type AgentBackend,
  type AgentSession,
  type AgentSessionOptions,
  type AgentSessionSettings,
  type SessionHooks,
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
  let path: string
  try {
    path = resolve(`@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude`)
  } catch {
    // No platform package here (or a variant, such as musl on Linux, that the SDK picks for itself).
    return undefined
  }
  return ASAR.test(path) ? path.replace(ASAR, '$1app.asar.unpacked$2') : undefined
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

/** What names Glade to the API, in the User-Agent of each session's requests: `glade/0.13.0`. */
export function clientAppEnv(version: string): Environment {
  return { CLAUDE_AGENT_SDK_CLIENT_APP: `glade/${version}` }
}

/**
 * The SDK permission mode each of Glade's runs in (`docs/sdk-notes.md` §9): Allow all bypasses every check, so
 * `canUseTool` is never called; the ask mode runs `default`, where Claude Code asks `canUseTool` about every call its
 * rules and the user's settings leave at "ask".
 */
export function sdkPermissionMode(mode: PermissionMode): SdkPermissionMode {
  switch (mode) {
    case PermissionMode.AllowAll:
      return 'bypassPermissions'
    case PermissionMode.AskBeforeEdits:
      return 'default'
  }
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

/**
 * The SDK hooks that tell `hooks` what the session does (`docs/sdk-notes.md` §13 and §14): each prompt that's about to
 * start a turn (`UserPromptSubmit`), which it can turn away, the jobs the session has scheduled at the end of each turn
 * (`Stop`), and each `Bash` call about to run (`PreToolUse`), which waits for the host a while at most. A hook that
 * fails lets the prompt or call through, and tells nothing.
 */
export function sdkHooks(
  hooks: SessionHooks,
  log: Logger = SILENT_LOGGER,
  bashTimeoutMs: number = BASH_HOOK_TIMEOUT_MS,
): NonNullable<Options['hooks']> {
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
  const onStop: HookCallback = (input) => {
    try {
      hooks.onTurnEnded(sessionJobs(input, log))
    } catch (error) {
      log.error('failed to read the scheduled jobs', { error })
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
  return {
    UserPromptSubmit: [{ hooks: [onPrompt] }],
    Stop: [{ hooks: [onStop] }],
    ...(onBashStarting === undefined ? {} : { PreToolUse: [{ matcher: 'Bash', hooks: [onBash] }] }),
  }
}

/** The SDK options for a session that runs in `env`. */
export function sdkOptions(
  options: AgentSessionOptions,
  env: Environment,
  resolve: ModuleResolver = createRequire(import.meta.url).resolve,
): Options {
  const executable = claudeCodeExecutable(resolve)
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
    permissionMode: sdkPermissionMode(options.permissionMode),
    allowDangerouslySkipPermissions: true,
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
    settings: { deniedMcpServers: [{ serverName: CONTROL_SERVER_NAME }] },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: options.systemPromptAppend },
    mcpServers: { ...options.mcpServers },
    // Questions go through Glade's own `ask`, which shows them on a card; Claude Code's own asking tool has no UI here.
    disallowedTools: ['AskUserQuestion'],
    // A subagent's own text too, not just its tool calls: the Subagents tab shows the last thing each one said.
    forwardSubagentText: true,
    // What the Claude Code process prints to its error output goes to the task's log, within limits (docs/logs.md).
    stderr: stderrLogger(options.log ?? SILENT_LOGGER),
    // Glade stops each background subagent and watcher from its own tab (`stopTask`), so Stop on a turn ends only the
    // turn. Without this, the SDK fails closed and an interrupt kills every background subagent (docs/sdk-notes.md §7).
    perTaskStopAffordance: true,
    // What the session's watchers do, which only its hooks tell (the Watchers tab, docs/sdk-notes.md §13).
    ...(options.hooks === undefined ? {} : { hooks: sdkHooks(options.hooks, options.log ?? SILENT_LOGGER) }),
  }
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
                await session.setPermissionMode(sdkPermissionMode(permissionMode))
                log.info('permission mode changed', { permissionMode })
              } catch (error) {
                log.warn("the SDK refused the session's new permission mode", { permissionMode, error })
              }
            }
          })
        },
        async interrupt() {
          log.info('agent interrupted')
          await (await started).interrupt()
        },
        async stopTask(sdkTaskId) {
          log.info('agent task stopped', { sdkTaskId })
          await (await started).stopTask(sdkTaskId)
        },
        async accountInfo() {
          return (await started).accountInfo()
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
