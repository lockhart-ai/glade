// The real agent backend: a thin adapter from `AgentBackend` onto the Claude Agent SDK's `query()`. Everything Glade
// decides about a session (its folder, model, prompt, settings, permissions) is here; see `docs/sdk-notes.md`.
import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from './async-queue'
import type { AgentBackend, AgentSession, AgentSessionOptions } from './backend'

/** Where the adapter reports a settings change the SDK refused. */
export interface SdkBackendLog {
  warn(message: string, error: unknown): void
}

/** The SDK options for a session. */
export function sdkOptions(options: AgentSessionOptions): Options {
  return {
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
    // No `env` and no credentials: the bundled Claude Code binary finds the user's own login itself.
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
 * user's messages into, turn after turn.
 *
 * A settings change and the messages after it are delivered in order: the next message waits for `setModel` and
 * `applyFlagSettings` to finish (`docs/sdk-notes.md` §4). If the SDK refuses a change, the message still goes, on the
 * settings the session had.
 */
export function createSdkBackend(log: SdkBackendLog = console): AgentBackend {
  return {
    start(options): AgentSession {
      const input = new AsyncQueue<SDKUserMessage>()
      const session = query({ prompt: input, options: sdkOptions(options) })
      // Everything asked of the session so far, in order.
      let queue = Promise.resolve()
      const then = (step: () => Promise<void> | void): void => {
        queue = queue.then(step)
      }
      return {
        messages: session,
        send(text, uuid) {
          then(() => {
            input.push(userMessage(text, uuid))
          })
        },
        configure({ model, effort }) {
          then(async () => {
            try {
              await session.setModel(model)
              await session.applyFlagSettings({ effortLevel: effort })
            } catch (error) {
              log.warn(`Couldn't change the session to ${model} at ${effort} effort`, error)
            }
          })
        },
        async interrupt() {
          await session.interrupt()
        },
        async stopTask(sdkTaskId) {
          await session.stopTask(sdkTaskId)
        },
        close() {
          then(() => {
            input.end()
          })
          session.close()
        },
      }
    },
  }
}
