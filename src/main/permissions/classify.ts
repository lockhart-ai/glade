/**
 * Which tool calls ask in the ask mode (`docs/decisions.md`, "Per-call permission review"). Claude Code only asks
 * Glade (`canUseTool`) about a call its own rules and the user's settings leave at "ask"; this decides whether that
 * call waits on you or goes ahead at once:
 *
 * - **Allowed at once:** reads and searches, Claude Code's todo and subagent tools, the agent's follow-up tools that
 *   only schedule the agent itself (`ScheduleWakeup`, `CronCreate`, `CronDelete`, `CronList`) or only tell you or list
 *   its agents (`PushNotification`, `ListAgents`), Glade's own tools, and the reads of Glade's control tools
 *   (`glade-control`'s `list_*` and `get_*`, `docs/control-api.md`). A Glade tool is one on an in-process server Glade
 *   registered: the SDK says `mcpServer.source` is `sdk` and the server's name is one of Glade's own (`glade`, whose
 *   tools only touch the task itself), or `glade-control` for its reads. The tool's name prefix proves nothing: any
 *   server can call itself anything.
 * - **Ask:** `Bash`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `Monitor` (it runs a shell command, as `Bash` does),
 *   `RemoteTrigger` and `SendMessage` (they reach outside), `glade-control`'s tools that change things (they change
 *   other tasks), other MCP servers' tools (a `glade-control` that isn't Glade's in-process one included, reads and
 *   all), and any tool Glade doesn't know.
 * - A call a user `permissions.ask` rule forced (`matchedAskRule`) always asks, even a read: that's what the rule is for.
 */
import type { McpServerOrigin } from '../agent/backend'
import { parseMcpToolName } from '../agent/mcp-tool-caller'
import { CONTROL_SERVER, isControlRead } from '../control/names'

/** Whether a tool call waits on you. */
export enum PermissionVerdict {
  /** It runs without asking. */
  Allow = 'allow',
  /** It waits on a permission request. */
  Ask = 'ask',
}

/** Claude Code's tools that only read or search. */
export const READ_ONLY_TOOLS: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
]

/** Claude Code's todo tools: they only change the agent's own list (`src/main/todos`). */
export const TODO_TOOLS: readonly string[] = ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList']

/**
 * Claude Code's subagent tools: starting one (`Agent`, called `Task` in older versions), reading its output and
 * stopping it. A subagent's own calls ask for themselves.
 */
export const SUBAGENT_TOOLS: readonly string[] = ['Agent', 'Task', 'TaskOutput', 'TaskStop']

/**
 * Claude Code's follow-up tools that only touch the agent itself: scheduling its own wake-ups and recurring prompts, a
 * notification to you, and listing its agents. None changes a file or reaches outside.
 */
export const SELF_TOOLS: readonly string[] = [
  'ScheduleWakeup',
  'CronCreate',
  'CronDelete',
  'CronList',
  'PushNotification',
  'ListAgents',
]

/**
 * Tools that always ask: they change files, run commands (`Monitor` runs a shell command, as `Bash` does) or reach
 * outside (`RemoteTrigger`, and `SendMessage`, which may). Anything Glade doesn't know asks too.
 */
export const SIDE_EFFECT_TOOLS: readonly string[] = [
  'Bash',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Monitor',
  'RemoteTrigger',
  'SendMessage',
]

const ALLOWED: ReadonlySet<string> = new Set([...READ_ONLY_TOOLS, ...TODO_TOOLS, ...SUBAGENT_TOOLS, ...SELF_TOOLS])

/** The SDK's `mcpServer.source` for an in-process server the host registered. */
const HOST_SOURCE = 'sdk'

/** What deciding a call reads. */
export interface ClassifiedCall {
  readonly toolName: string
  /** The server serving an MCP tool; null for any other tool. */
  readonly mcpServer: McpServerOrigin | null
  /** Whether a user `permissions.ask` rule forced the prompt. */
  readonly matchedAskRule: boolean
}

/** Whether an MCP tool call to an in-process server Glade registered goes ahead without asking. */
function hostToolAllowed(toolName: string, server: string, gladeServers: readonly string[]): boolean {
  if (gladeServers.includes(server)) return true
  const tool = parseMcpToolName(toolName)?.tool
  return server === CONTROL_SERVER && tool !== undefined && isControlRead(tool)
}

/**
 * Whether a call waits on you in the ask mode. `gladeServers` names Glade's own in-process MCP servers: `glade` only
 * (`gladeOwnServers`), not `glade-control`, whose reads alone go ahead.
 */
export function permissionVerdict(call: ClassifiedCall, gladeServers: readonly string[]): PermissionVerdict {
  if (call.matchedAskRule) return PermissionVerdict.Ask
  const { mcpServer } = call
  if (mcpServer !== null) {
    const allowed = mcpServer.source === HOST_SOURCE && hostToolAllowed(call.toolName, mcpServer.name, gladeServers)
    return allowed ? PermissionVerdict.Allow : PermissionVerdict.Ask
  }
  // An MCP tool the SDK didn't say the server of isn't one Glade can vouch for.
  if (call.toolName.startsWith('mcp__')) return PermissionVerdict.Ask
  return ALLOWED.has(call.toolName) ? PermissionVerdict.Allow : PermissionVerdict.Ask
}
