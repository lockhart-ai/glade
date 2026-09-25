/**
 * Glade's control API (`docs/control-api.md`, `docs/decisions.md` "Programmatic control"): the `glade-control` MCP
 * server over the control service, which other agents drive Glade with.
 *
 * Every call goes through `call`, whoever makes it and however it arrives: it's refused with `disabled` while the switch
 * in Settings › Control is off (checked each call, so a live session's tools stop working at once), then counted against
 * the caller's rate limit (`./rate-limit`), then its input is checked, then a task is kept from turning on itself
 * (stopping, deleting or messaging itself, through its own in-process server), and only then does it run. Each call is
 * logged in the `control` scope: the tool, the caller, the task it acts on, how long it took and how it came out.
 *
 * `sdkServer` makes the in-process server a task's session gets, bound to that task as its caller. Its tools aren't
 * `alwaysLoad`: they sit behind tool search until the agent looks for them.
 */
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { getSettings } from '../db/repositories/settings'
import { excerpt } from '../logging/format'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import { ControlError, ControlErrorCode, controlErrorFrom } from './errors'
import { CONTROL_SERVER } from './names'
import { createRateLimiter, type RateLimiter } from './rate-limit'
import { createControlService, type ControlService, type ControlServiceContext } from './service'
import {
  callerKey,
  CONTROL_TOOLS,
  ControlCallerKind,
  type ControlCaller,
  type ControlResult,
  type ControlTool,
} from './tools'

/** The version the server tells its clients. */
const SERVER_VERSION = '1.0.0'

export interface ControlOptions extends ControlServiceContext {
  /** Where each call is logged, in the `control` scope. Nothing by default. */
  readonly log?: Logger
  /** The rate limits. 3,000 reads and 1,200 changes a minute per caller by default. */
  readonly limiter?: RateLimiter
  /** The tools served. Every `glade-control` tool by default. */
  readonly tools?: readonly ControlTool[]
}

/** How a call came out: its result, or the error it failed with. */
export type ControlOutcome =
  { readonly ok: true; readonly result: ControlResult } | { readonly ok: false; readonly error: ControlError }

export interface Control {
  readonly service: ControlService
  readonly tools: readonly ControlTool[]
  /** The tools as `tools/list` gives them: name, description and JSON input schema. */
  readonly listing: readonly Tool[]
  /** Whether `name` is one of the tools served. */
  has(name: string): boolean
  /** Calls a tool by name as `caller`: how it came out. Throws for a tool that isn't one. */
  invoke(caller: ControlCaller, name: string, input: unknown): Promise<ControlOutcome>
  /** Calls a tool by name as `caller`: its result, or a tool error with its code. Throws for a tool that isn't one. */
  call(caller: ControlCaller, name: string, input: unknown): Promise<CallToolResult>
  /** An MCP server serving the tools to `caller`, for any transport. */
  server(caller: ControlCaller): McpServer
  /** The in-process server for a task's session, calling as that task. */
  sdkServer(taskId: string): McpSdkServerConfigWithInstance
}

/** A call under way: the task it acts on, once its input is checked, which its log line is about. */
interface Attempt {
  target: string | null
}

/** A tool's answer: its JSON, as `structuredContent` and as text for clients that only read text. */
function success(result: ControlResult): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: { ...result } }
}

/** A tool error: `{ error: { code, message } }`, as `structuredContent` and as text. */
function failure(error: ControlError): CallToolResult {
  const body = { error: error.body }
  return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body, isError: true }
}

export function createControl(options: ControlOptions): Control {
  const { db } = options
  const log = options.log ?? SILENT_LOGGER
  const limiter = options.limiter ?? createRateLimiter()
  const tools = options.tools ?? CONTROL_TOOLS
  const now = options.now ?? (() => Date.now())
  const service = createControlService(options)
  const byName = new Map(tools.map((tool) => [tool.name as string, tool]))

  /** Runs a call through the switch, the rate limit, the input check and the self-guard. */
  const run = async (
    tool: ControlTool,
    caller: ControlCaller,
    input: unknown,
    attempt: Attempt,
  ): Promise<ControlResult> => {
    if (!getSettings(db).controlEnabled) {
      throw new ControlError(
        ControlErrorCode.Disabled,
        'Agents may not control Glade: turn it on in Settings › Control',
      )
    }
    const rate = limiter.take(callerKey(caller), tool.access)
    if (!rate.ok) {
      const seconds = String(Math.ceil(rate.retryAfterMs / 1000))
      const message = `Too many ${tool.access} calls in a minute; try again in ${seconds}s`
      throw new ControlError(ControlErrorCode.RateLimited, message, rate.retryAfterMs)
    }
    const prepared = tool.prepare(input)
    attempt.target = prepared.target
    if (tool.forbidsSelf && caller.kind === ControlCallerKind.Task && caller.taskId === prepared.target) {
      throw new ControlError(ControlErrorCode.Forbidden, `A task can't ${tool.name.replaceAll('_', ' ')} itself`)
    }
    if (prepared.text !== null) log.debug('control text', { tool: tool.name, text: excerpt(prepared.text) })
    return prepared.run({ service, caller })
  }
  /** The log, about the task a call acts on, if it acts on one. */
  const about = ({ target }: Attempt): Logger => (target === null ? log : log.with({ taskId: target }))

  const invoke = async (caller: ControlCaller, name: string, input: unknown): Promise<ControlOutcome> => {
    const tool = byName.get(name)
    if (tool === undefined) throw new McpError(ErrorCode.InvalidParams, `No tool named ${name}`)
    const startedAt = now()
    const attempt: Attempt = { target: null }
    const fields = { tool: name, caller: callerKey(caller) }
    try {
      const result = await run(tool, caller, input, attempt)
      about(attempt).info('control call', { ...fields, durationMs: now() - startedAt, outcome: 'ok' })
      return { ok: true, result }
    } catch (thrown) {
      const error = controlErrorFrom(thrown)
      const outcome = { ...fields, durationMs: now() - startedAt, outcome: error.code }
      const line = about(attempt)
      if (error.code === ControlErrorCode.Internal) line.error('control call failed', { ...outcome, error: thrown })
      else line.info('control call', { ...outcome, message: error.message })
      return { ok: false, error }
    }
  }

  const call = async (caller: ControlCaller, name: string, input: unknown): Promise<CallToolResult> => {
    const outcome = await invoke(caller, name, input)
    return outcome.ok ? success(outcome.result) : failure(outcome.error)
  }

  const listed: Tool[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { ...tool.inputSchema, type: 'object' },
  }))

  const server = (caller: ControlCaller): McpServer => {
    const mcp = new McpServer({ name: CONTROL_SERVER, version: SERVER_VERSION }, { capabilities: { tools: {} } })
    mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listed }))
    mcp.server.setRequestHandler(CallToolRequestSchema, (request) =>
      call(caller, request.params.name, request.params.arguments),
    )
    return mcp
  }

  return {
    service,
    tools,
    listing: listed,
    has: (name) => byName.has(name),
    invoke,
    call,
    server,
    sdkServer: (taskId) => ({
      type: 'sdk',
      name: CONTROL_SERVER,
      instance: server({ kind: ControlCallerKind.Task, taskId }),
    }),
  }
}
