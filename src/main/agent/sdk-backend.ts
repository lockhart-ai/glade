// The real agent backend: a thin adapter from `AgentBackend` onto the Claude Agent SDK's `query()`. Everything Glade
// decides about a session (its folder, model, prompt, settings, permissions) is here; see `docs/sdk-notes.md`.
import { query, type Options, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { createRequire } from 'node:module'
import type { Environment } from '../login-env'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import { AsyncQueue } from './async-queue'
import type { AgentBackend, AgentSession, AgentSessionOptions } from './backend'

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
    // Allow all: no per-call permission review (docs/decisions.md).
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
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

/** The SDK user message for the user's next message, stamped as typed by a person. */
export function userMessage(text: string, uuid: string): SDKUserMessage {
  return {
    type: 'user',
    uuid: uuid as SDKUserMessage['uuid'],
    parent_tool_use_id: null,
    origin: { kind: 'human' },
    message: { role: 'user', content: text },
  }
}

/**
 * Starts each session as one long-lived `query()` in streaming input mode: its prompt is a queue the session pushes the
 * user's messages into, turn after turn. The `query()`, and with it the agent process, starts once `env` is known; a
 * session started before then takes messages and settings meanwhile, and delivers them in order once it runs.
 *
 * A settings change and the messages after it are delivered in order: the next message waits for `setModel` and
 * `applyFlagSettings` to finish (`docs/sdk-notes.md` §4). If the SDK refuses a change, the message still goes, on the
 * settings the session had.
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
          resumeSessionId: options.resumeSessionId,
          mcpServers: Object.keys(options.mcpServers),
          PATH: resolved.PATH ?? null,
        })
        return query({ prompt: input, options: sdk })
      })
      // Everything asked of the session so far, in order.
      let queue = Promise.resolve()
      const then = (step: () => Promise<void> | void): void => {
        queue = queue.then(step)
      }
      return {
        messages: (async function* () {
          yield* await started
        })(),
        send(text, uuid) {
          then(() => {
            input.push(userMessage(text, uuid))
          })
        },
        configure({ model, effort }) {
          then(async () => {
            const session = await started
            try {
              await session.setModel(model)
              await session.applyFlagSettings({ effortLevel: effort })
            } catch (error) {
              log.warn("the SDK refused the session's new settings", { model, effort, error })
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
