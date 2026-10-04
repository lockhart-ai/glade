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
  type BashCallFinished,
  type BashFinishedAnswer,
  type CompactSummary,
  type BashCallStarting,
  type SandboxFlagSettings,
  type SessionJob,
  type ToolCallStarting,
  type ToolPermissionAnswer,
  type ToolPermissionCall,
  type ToolStartDecision,
} from './backend'
import { createMcpToolCaller, type McpToolCaller } from './mcp-tool-caller'
import { REQUEST_ACCESS_TOOL } from '../../shared/toolName'
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
/** Who makes a tool call (`FakeAgentSession.callTool`): the agent itself by default. */
export interface ToolCaller {
  /** The SDK's id for the subagent making the call. */
  readonly agentId?: string
  /** The subagent's `Agent` call. */
  readonly parent?: string
  /** Whether the call's `tool_use` id goes with the tool's request: true by default. */
  readonly namesCall?: boolean
}

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
      blockedPath: null,
      decisionReason: null,
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

  /** Tells the session's `PostCompact` hook the summary a compaction wrote, as the SDK does before its boundary. */
  compacted(compaction: CompactSummary): void {
    this.options.hooks?.onCompacted(compaction)
  }

  /**
   * What `contextUsage` answers, as the SDK's `getContextUsage` would. By default it never answers, so a test about
   * something else sees the task left alone; a test of the threshold sets an answer, or a rejection.
   */
  onContextUsage: () => Promise<unknown> = () => new Promise<unknown>(() => undefined)

  /** How many times the runner asked for the context usage. */
  contextUsageAsked = 0

  contextUsage(): Promise<unknown> {
    this.contextUsageAsked += 1
    return this.onContextUsage()
  }

  /**
   * Tells the session's `PreToolUse` hook a `Bash` call is about to run, as the SDK does before running one
   * (`docs/sdk-notes.md` §14), and resolves once the hook has; at once with no hook.
   */
  startBash(call: BashCallStarting): Promise<void> {
    return this.options.hooks?.onBashStarting?.(call) ?? Promise.resolve()
  }

  /**
   * Puts a call to a tool the sandbox bounds to the session's `PreToolUse` hook, as the SDK does before it matches any
   * rule, in every permission mode (`docs/sdk-notes.md` §15), and resolves with what the hook decided: null when it
   * leaves the call to Claude Code, and with no such hook (a session that isn't sandboxed). `abort` cancels the hook's
   * signal, as the SDK does on an interrupt.
   */
  startTool(call: Omit<ToolCallStarting, 'signal' | 'agentId'> & { readonly agentId?: string | null }): {
    readonly decision: Promise<ToolStartDecision | null>
    abort(): void
  } {
    const controller = new AbortController()
    const hook = this.options.hooks?.onToolStarting
    return {
      decision:
        hook === undefined
          ? Promise.resolve(null)
          : hook({ ...call, agentId: call.agentId ?? null, signal: controller.signal }),
      abort: () => {
        controller.abort()
      },
    }
  }

  /**
   * Tells the session's `PostToolUse` (or, for a failed call, `PostToolUseFailure`) hook a `Bash` call has run, as the
   * SDK does before the call's result (`docs/sdk-notes.md` §15), and resolves with what the hook answered: nothing to
   * add with no hook. `abort` cancels the hook's signal, as the SDK does on an interrupt.
   */
  finishBash(call: Omit<BashCallFinished, 'signal'>): { readonly answer: Promise<BashFinishedAnswer>; abort(): void } {
    const controller = new AbortController()
    const hook = this.options.hooks?.onBashFinished
    return {
      answer: hook === undefined ? Promise.resolve({ context: null }) : hook({ ...call, signal: controller.signal }),
      abort: () => {
        controller.abort()
      },
    }
  }

  /** Every `applyFlagSettings` the runner asked for, in order. */
  readonly flagSettings: SandboxFlagSettings[] = []

  /** What applying flag settings does once recorded, as the SDK would: applies them at once by default. */
  onApplyFlagSettings: (settings: SandboxFlagSettings) => Promise<void> = () => Promise.resolve()

  applyFlagSettings(settings: SandboxFlagSettings): Promise<void> {
    this.flagSettings.push(settings)
    return this.onApplyFlagSettings(settings)
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

  /** How many times the runner asked about the account. */
  accountInfoCalls = 0

  /**
   * What the session says about the account when asked (`accountInfo`), as the SDK would. By default it never answers,
   * so a test that doesn't care about the account sees nothing change.
   */
  onAccountInfo: () => Promise<unknown> = () => new Promise(() => undefined)

  accountInfo(): Promise<unknown> {
    this.accountInfoCalls += 1
    return this.onAccountInfo()
  }

  /** How many times the runner asked how much of the usage limits is used. */
  usageCalls = 0

  /**
   * What the session says of the usage limits when asked (`usage`), as the SDK's experimental call would. By default it
   * never answers, so a test that doesn't care about usage sees nothing change.
   */
  onUsage: () => Promise<unknown> = () => new Promise(() => undefined)

  usage(): Promise<unknown> {
    this.usageCalls += 1
    return this.onUsage()
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
   * and this rejects without streaming a result. A call to `request_access` tells the session's `PreToolUse` hook
   * first, as the SDK does, and `caller` says whose it is: a subagent's (`agentId`, under its `Agent` call `parent`),
   * and whether the call's id goes with the tool's request, as Claude Code sends it (`namesCall`, true by default).
   */
  async callTool(
    toolUseId: string,
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    caller: ToolCaller = {},
  ): Promise<void> {
    this.emit(toolUse(toolUseId, name, input, caller.parent ?? null))
    if (name === REQUEST_ACCESS_TOOL) {
      this.options.hooks?.onAccessRequested?.({ toolUseId, agentId: caller.agentId ?? null, input })
    }
    const named = caller.namesCall === false ? undefined : toolUseId
    const { output, isError } = await this.tools.call(name, input, signal, named)
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

  /** Sets up each session as it starts, before the runner asks anything of it: nothing by default. */
  onSessionStart: (session: FakeAgentSession) => void = () => undefined

  /** What each session started from now on says about the account; unset, each never answers. */
  onAccountInfo?: () => Promise<unknown>

  /** What each session started from now on says of the usage limits; unset, each never answers. */
  onUsage?: () => Promise<unknown>

  start(options: AgentSessionOptions): FakeAgentSession {
    const session = new FakeAgentSession(options)
    if (this.onAccountInfo !== undefined) session.onAccountInfo = this.onAccountInfo
    if (this.onUsage !== undefined) session.onUsage = this.onUsage
    this.onSessionStart(session)
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
