// Test helper: an agent backend whose sessions stream whatever SDK messages a test scripts, and record what the runner
// asks of them. Nothing runs a model.
import { AsyncQueue } from './async-queue'
import type { AgentBackend, AgentSession, AgentSessionOptions, AgentSessionSettings } from './backend'
import { createMcpToolCaller, type McpToolCaller } from './mcp-tool-caller'
import { toolResult, toolUse } from './test-sdk-messages'

/** A message the runner sent a session. */
export interface SentMessage {
  readonly text: string
  readonly uuid: string
  /** The model and effort the session had when the message was delivered: what its turn runs with. */
  readonly settings: AgentSessionSettings
}

export class FakeAgentSession implements AgentSession {
  readonly sent: SentMessage[] = []
  /** Every settings change the runner asked for, in order. */
  readonly configured: AgentSessionSettings[] = []
  interrupts = 0
  closed = false
  private readonly stream = new AsyncQueue<unknown>()
  readonly messages: AsyncIterable<unknown> = this.stream
  private readonly tools: McpToolCaller

  /** The model and effort the session runs with now. */
  settings: AgentSessionSettings

  constructor(readonly options: AgentSessionOptions) {
    this.tools = createMcpToolCaller(options.mcpServers)
    this.settings = { model: options.model, effort: options.effort }
  }

  send(text: string, uuid: string): void {
    this.sent.push({ text, uuid, settings: this.settings })
  }

  configure(settings: AgentSessionSettings): void {
    this.configured.push(settings)
    this.settings = settings
  }

  interrupt(): Promise<void> {
    this.interrupts += 1
    return Promise.resolve()
  }

  close(): void {
    this.closed = true
    this.stream.end()
    void this.tools.close()
  }

  /** Streams SDK messages to the runner, as the agent would. */
  emit(...messages: readonly unknown[]): void {
    for (const message of messages) this.stream.push(message)
  }

  /**
   * Calls one of the session's in-process MCP tools, as the agent would: streams the `tool_use`, runs the tool's real
   * handler through its MCP server, then streams the `tool_result` it gave. Resolves once the result is streamed.
   */
  async callTool(toolUseId: string, name: string, input: Record<string, unknown>): Promise<void> {
    this.emit(toolUse(toolUseId, name, input))
    const { output, isError } = await this.tools.call(name, input)
    this.emit(toolResult(toolUseId, [{ type: 'text', text: output }], isError))
  }

  /** Ends the stream, as a session whose process exited would. */
  end(): void {
    this.stream.end()
  }

  /** Fails the stream, as a session whose process crashed would. */
  fail(error: Error): void {
    this.stream.fail(error)
  }
}

export class FakeAgentBackend implements AgentBackend {
  readonly sessions: FakeAgentSession[] = []

  start(options: AgentSessionOptions): FakeAgentSession {
    const session = new FakeAgentSession(options)
    this.sessions.push(session)
    return session
  }

  /** The session started last. Throws if none has been. */
  get session(): FakeAgentSession {
    const session = this.sessions.at(-1)
    if (session === undefined) throw new Error('No agent session has started')
    return session
  }
}

/** Waits until the runner has handled everything streamed so far. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
