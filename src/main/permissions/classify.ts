/**
 * Which tool calls ask in the ask mode (`docs/decisions.md`, "Per-call permission review"). Claude Code only asks
 * Glade (`canUseTool`) about a call its own rules and the user's settings leave at "ask"; this decides whether that
 * call waits on you or goes ahead at once:
 *
 * - **Allowed at once:** reads and searches, Claude Code's todo and subagent tools, and Glade's own tools. A Glade tool
 *   is one on an in-process server Glade registered: the SDK says `mcpServer.source` is `sdk` and the server's name is
 *   one of Glade's. The tool's name prefix proves nothing: any server can call itself anything.
 * - **Ask:** `Bash`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, other MCP servers' tools, and any tool Glade doesn't
 *   know.
 * - A call a user `permissions.ask` rule forced (`matchedAskRule`) always asks, even a read: that's what the rule is for.
 */
import type { McpServerOrigin } from '../agent/backend'

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

/** Tools that always ask: they change files or run commands. Anything Glade doesn't know asks too. */
export const SIDE_EFFECT_TOOLS: readonly string[] = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']

const ALLOWED: ReadonlySet<string> = new Set([...READ_ONLY_TOOLS, ...TODO_TOOLS, ...SUBAGENT_TOOLS])

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

/** Whether a call waits on you in the ask mode. `gladeServers` names Glade's own in-process MCP servers. */
export function permissionVerdict(call: ClassifiedCall, gladeServers: readonly string[]): PermissionVerdict {
  if (call.matchedAskRule) return PermissionVerdict.Ask
  const { mcpServer } = call
  if (mcpServer !== null) {
    const gladeOwn = mcpServer.source === HOST_SOURCE && gladeServers.includes(mcpServer.name)
    return gladeOwn ? PermissionVerdict.Allow : PermissionVerdict.Ask
  }
  // An MCP tool the SDK didn't say the server of isn't one Glade can vouch for.
  if (call.toolName.startsWith('mcp__')) return PermissionVerdict.Ask
  return ALLOWED.has(call.toolName) ? PermissionVerdict.Allow : PermissionVerdict.Ask
}
