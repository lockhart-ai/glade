/**
 * The seam between the agent runner and the Claude Agent SDK. The runner only ever talks to an `AgentBackend`: the app
 * starts with the real one (`createSdkBackend` in `./sdk-backend`), and tests (and, later, the end-to-end tests' test
 * mode) pass a scripted one instead.
 */
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { Effort } from '../../shared/domain'
import type { ImageData } from '../../shared/images'

/**
 * In-process MCP servers to give a session, by server name, e.g. `{ glade: createSdkMcpServer({ name: 'glade', … }) }`.
 * Create them with `alwaysLoad: true`, or the model has to find their tools through tool search first
 * (`docs/sdk-notes.md` §3).
 */
export type AgentMcpServers = Readonly<Record<string, McpServerConfig>>

/** The settings a task can change between turns (`docs/sdk-notes.md` §4). */
export interface AgentSessionSettings {
  /** The model id, as the SDK names it. */
  readonly model: string
  readonly effort: Effort
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
   * Changes the model and effort for the turns after it: every message sent after this call runs with them. Call it
   * between turns, never mid-turn.
   */
  configure(settings: AgentSessionSettings): void
  /** Interrupts the running turn, which then ends with an aborted result; the session stays alive. Stop uses it. */
  interrupt(): Promise<void>
  /**
   * Stops one of the session's tasks, such as a subagent, by the SDK's id for it (`system/task_started`), leaving the
   * turn running: the tool call that started it gets its result. Stop subagent uses it.
   */
  stopTask(sdkTaskId: string): Promise<void>
  /** Ends the session and its agent process. */
  close(): void
}

/** Starts agent sessions. */
export interface AgentBackend {
  start(options: AgentSessionOptions): AgentSession
}
