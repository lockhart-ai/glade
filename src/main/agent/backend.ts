/**
 * The seam between the agent runner and the Claude Agent SDK. The runner only ever talks to an `AgentBackend`: the app
 * starts with the real one (`createSdkBackend` in `./sdk-backend`), and tests (and, later, the end-to-end tests' test
 * mode) pass a scripted one instead.
 */
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { Effort } from '../../shared/domain'

/**
 * In-process MCP servers to give a session, by server name, e.g. `{ glade: createSdkMcpServer({ name: 'glade', … }) }`.
 * Create them with `alwaysLoad: true`, or the model has to find their tools through tool search first
 * (`docs/sdk-notes.md` §3).
 */
export type AgentMcpServers = Readonly<Record<string, McpServerConfig>>

/** How to start one task's agent session. */
export interface AgentSessionOptions {
  /** The folder the agent runs in: the workspace's root. */
  readonly cwd: string
  /** The model id, as the SDK names it. */
  readonly model: string
  readonly effort: Effort
  /** The SDK session to resume, or null to start a new one. */
  readonly resumeSessionId: string | null
  /** Appended to Claude Code's own system prompt. */
  readonly systemPromptAppend: string
  readonly mcpServers: AgentMcpServers
}

/**
 * One live agent session: a long-lived SDK `query()` in streaming input mode. Its `messages` stream runs for the
 * session's whole life, across turns. It finishes when the session is closed and throws if the agent process fails.
 */
export interface AgentSession {
  /** Every message the SDK emits, unparsed: the runner parses each one at the boundary. Iterate it once. */
  readonly messages: AsyncIterable<unknown>
  /** Gives the agent the user's next message. `uuid` comes back on the turn's messages. */
  send(text: string, uuid: string): void
  /** Interrupts the running turn; the session stays alive. The seam for Stop (P1-08). */
  interrupt(): Promise<void>
  /** Ends the session and its agent process. */
  close(): void
}

/** Starts agent sessions. */
export interface AgentBackend {
  start(options: AgentSessionOptions): AgentSession
}
