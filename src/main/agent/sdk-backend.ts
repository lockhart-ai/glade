// The real agent backend: a thin adapter from `AgentBackend` onto the Claude Agent SDK's `query()`. Everything Glade
// decides about a session (its folder, model, prompt, settings, permissions) is here; see `docs/sdk-notes.md`.
import {
  query,
  type CanUseTool,
  type Options,
  type PermissionMode as SdkPermissionMode,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { createRequire } from 'node:module'
import { PermissionMode, type PermissionSuggestion, type ToolInput } from '../../shared/domain'
import { permissionRuleString } from '../../shared/permissions'
import type { ImageData } from '../../shared/images'
import type { Environment } from '../login-env'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import { permissionSuggestionSchema } from '../permissions/schema'
import { AsyncQueue } from './async-queue'
import { gladeOwnServers } from './glade-tools'
import {
  ToolPermissionBehavior,
  type AgentBackend,
  type AgentSession,
  type AgentSessionOptions,
  type AgentSessionSettings,
  type ToolPermissionAnswer,
  type ToolPermissionCall,
  type ToolPermissionHandler,
} from './backend'
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
 */
export const SESSION_ENV: Environment = { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' }

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
    env: { ...env, ...SESSION_ENV },
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
    systemPrompt: { type: 'preset', preset: 'claude_code', append: options.systemPromptAppend },
    mcpServers: { ...options.mcpServers },
    // Questions go through Glade's own `ask`, which shows them on a card; Claude Code's own asking tool has no UI here.
    disallowedTools: ['AskUserQuestion'],
    // A subagent's own text too, not just its tool calls: the Subagents tab shows the last thing each one said.
    forwardSubagentText: true,
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
 * session had.
 */
export function createSdkBackend({ env, log: backendLog = SILENT_LOGGER }: SdkBackendOptions): AgentBackend {
  return {
    start(options): AgentSession {
      const log = options.log ?? backendLog
      const input = new AsyncQueue<SDKUserMessage>()
      const started: Promise<Query> = env.then((resolved) => {
        const sdk = sdkOptions(options, resolved)
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
