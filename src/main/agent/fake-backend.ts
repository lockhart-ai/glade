// Test helper: an agent backend whose sessions stream whatever SDK messages a test scripts, and record what the runner
// asks of them. Nothing runs a model.
import type { ImageData } from '../../shared/images'
import { AsyncQueue } from './async-queue'
import {
  PromptVerdict,
  ToolPermissionBehavior,
  type AgentBackend,
  type AgentSession,
  type AgentSessionOptions,
  type AgentSessionSettings,
  type BashCallStarting,
  type SessionJob,
  type ToolPermissionAnswer,
  type ToolPermissionCall,
} from './backend'
import { createMcpToolCaller, type McpToolCaller } from './mcp-tool-caller'
import { toolResult, toolUse } from './test-sdk-messages'

/** What a test says of a tool call it asks the runner about: the rest is a plain top-level call, suggesting nothing. */
export type PermissionCallFields = Pick<ToolPermissionCall, 'toolName' | 'toolUseId' | 'input'> &
  Partial<Omit<ToolPermissionCall, 'signal'>>

/** A tool call asked about: the runner's answer, once it gives one, and a way to cancel it as the SDK does. */
export interface AskedPermission {
  readonly answer: Promise<ToolPermissionAnswer>
  /** Aborts the call's signal, as the SDK does when it cancels the call (e.g. on an interrupt). */
  abort(): void
}

/** A message the runner sent a session. */
export interface SentMessage {
  readonly text: string
  readonly uuid: string
  /** The images sent with it, in order. */
  readonly images: readonly ImageData[]
  /** The model and effort the session had when the message was delivered: what its turn runs with. */
  readonly settings: AgentSessionSettings
}

export class FakeAgentSession implements AgentSession {
  readonly sent: SentMessage[] = []
  /** Every settings change the runner asked for, in order. */
  readonly configured: AgentSessionSettings[] = []
  interrupts = 0
  /** The SDK task ids the runner asked to stop, in order. */
  readonly stoppedTasks: string[] = []
  closed = false
  private readonly stream = new AsyncQueue<unknown>()
  readonly messages: AsyncIterable<unknown> = this.stream
  private readonly tools: McpToolCaller

  /** The model and effort the session runs with now. */
  settings: AgentSessionSettings

  constructor(readonly options: AgentSessionOptions) {
    this.tools = createMcpToolCaller(options.mcpServers)
    this.settings = { model: options.model, effort: options.effort, permissionMode: options.permissionMode }
  }

  /**
   * Asks the runner about a tool call, as Claude Code does outside Allow all (`canUseTool`). Stream the call's
   * `tool_use` first, as the SDK does. With no handler, the call is denied, as the SDK backend denies it.
   */
  requestPermission(fields: PermissionCallFields): AskedPermission {
    const controller = new AbortController()
    const call: ToolPermissionCall = {
      agentId: null,
      title: null,
      displayName: null,
      description: null,
      suggestions: [],
      defaultToNo: false,
      suppressAlwaysAllowRule: false,
      mcpServer: null,
      matchedAskRule: false,
      ...fields,
      signal: controller.signal,
    }
    const handler = this.options.onToolPermission
    const answer =
      handler === undefined
        ? Promise.resolve<ToolPermissionAnswer>({ behavior: ToolPermissionBehavior.Deny, message: '', byUser: false })
        : handler(call)
    return {
      answer,
      abort: () => {
        controller.abort()
      },
    }
  }

  /**
   * Puts a prompt to the session's `UserPromptSubmit` hook, as the SDK does before a turn: one of the runner's own
   * messages, a background task's wake or a job firing (`docs/sdk-notes.md` §13). Answers the verdict; with no hooks,
   * everything goes ahead.
   */
  submitPrompt(prompt: string): PromptVerdict {
    return this.options.hooks?.onPrompt(prompt) ?? PromptVerdict.Allow
  }

  /**
   * Tells the session's `PreToolUse` hook a `Bash` call is about to run, as the SDK does before running one
   * (`docs/sdk-notes.md` §14), and resolves once the hook has; at once with no hook.
   */
  startBash(call: BashCallStarting): Promise<void> {
    return this.options.hooks?.onBashStarting?.(call) ?? Promise.resolve()
  }

  /** Tells the session's `Stop` hook the jobs it has, as the SDK does as each turn ends. */
  endTurn(jobs: readonly SessionJob[] = []): void {
    this.options.hooks?.onTurnEnded(jobs)
  }

  send(text: string, uuid: string, images: readonly ImageData[] = []): void {
    this.sent.push({ text, uuid, images, settings: this.settings })
  }

  configure(settings: AgentSessionSettings): void {
    this.configured.push(settings)
    this.settings = settings
  }

  /** What the session does when interrupted, as the agent would: e.g. stream an aborted turn. Nothing by default. */
  onInterrupt: () => Promise<void> = () => Promise.resolve()

  interrupt(): Promise<void> {
    this.interrupts += 1
    return this.onInterrupt()
  }

  stopTask(sdkTaskId: string): Promise<void> {
    this.stoppedTasks.push(sdkTaskId)
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
   * handler through its MCP server, then streams the `tool_result` it gave. Resolves once the result is streamed; a
   * blocking tool (`ask`) waits until it returns. Aborting `signal` cancels the call, as the SDK does on an interrupt,
   * and this rejects without streaming a result.
   */
  async callTool(toolUseId: string, name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    this.emit(toolUse(toolUseId, name, input))
    const { output, isError } = await this.tools.call(name, input, signal)
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
