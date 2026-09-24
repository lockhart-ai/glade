// The real agent backend: a thin adapter from `AgentBackend` onto the Claude Agent SDK's `query()`. Everything Glade
// decides about a session (its folder, model, prompt, settings, permissions) is here; see `docs/sdk-notes.md`.
import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from './async-queue'
import type { AgentBackend, AgentSession, AgentSessionOptions } from './backend'

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
 */
export function createSdkBackend(): AgentBackend {
  return {
    start(options): AgentSession {
      const input = new AsyncQueue<SDKUserMessage>()
      const session = query({ prompt: input, options: sdkOptions(options) })
      return {
        messages: session,
        send(text, uuid) {
          input.push(userMessage(text, uuid))
        },
        async interrupt() {
          await session.interrupt()
        },
        close() {
          input.end()
          session.close()
        },
      }
    },
  }
}
