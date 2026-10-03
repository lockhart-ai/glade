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
 *
 * With the agent sandbox on (#445, `toolCallVerdict`), crossing its bounds asks in either mode (`sandboxCrossing`): a
 * read under the home folder, `/Users` or `/Volumes` outside the workspace root and the granted folders, a write outside
 * the root and the read-write ones, `WebFetch` to a domain that isn't granted, and a command's connection to a host that
 * isn't (`SandboxNetworkAccess`). So does a command asking to run outside the sandbox, unless the sandbox couldn't start
 * in the session, when it's refused without asking. Reads outside the home folder, `/Users` and `/Volumes` (`/etc/hosts`,
 * `/usr/…`) go ahead, as do reads inside the bounds. In Allow all, every other call goes ahead; in the ask mode, the
 * rules above decide it. With the sandbox off, nothing changes: Allow all allows everything.
 */
import { isAbsolute, posix } from 'node:path'
import { PermissionMode, type ToolInput } from '../../shared/domain'
import type { McpServerOrigin } from '../agent/backend'
import { parseMcpToolName } from '../agent/mcp-tool-caller'
import { DENIED_READ_ROOTS, SandboxAccess, sandboxFolder, type SandboxGrants } from '../agent/sandbox'
import { hostMatches, isInside, SANDBOX_NETWORK_TOOL } from '../agent/sandbox-requests'
import { CONTROL_SERVER, isControlRead } from '../control/names'

/** Whether a tool call waits on you. */
export enum PermissionVerdict {
  /** It runs without asking. */
  Allow = 'allow',
  /** It waits on a permission request. */
  Ask = 'ask',
  /** It's refused without asking: a request to run outside a sandbox that couldn't start. */
  Refuse = 'refuse',
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

/** How a tool call stands to the agent sandbox's bounds. */
export enum SandboxCrossing {
  /** It stays inside them, or isn't something the sandbox bounds. */
  None = 'none',
  /** It reaches a folder or domain that isn't granted. */
  Boundary = 'boundary',
  /** It asks to run a command outside the sandbox (`dangerouslyDisableSandbox: true`). */
  Override = 'override',
}

/** The sandbox a session runs in, as deciding its calls reads it. */
export interface SandboxScope {
  /** The workspace root: the folder the agent may always read and write. */
  readonly root: string
  /** The home folder, whose reads are denied but for the root and granted folders. */
  readonly home: string
  readonly grants: SandboxGrants
  /** Whether the sandbox couldn't start in the session: every request to run outside it is then refused. */
  readonly failed: boolean
}

/** A call as deciding it against the sandbox reads it: its tool and input. */
export interface SandboxedCall {
  readonly toolName: string
  readonly input: ToolInput
}

/** The tools that only read, by the input field naming what they read; a search with no path searches the root. */
const READ_PATHS: Readonly<Record<string, string>> = {
  Read: 'file_path',
  NotebookRead: 'notebook_path',
  LS: 'path',
  Grep: 'path',
  Glob: 'path',
}

/** The file tools that write, by the input field naming the file. */
const WRITE_PATHS: Readonly<Record<string, string>> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
}

/** The path a call's input names in `field`, absolute (a relative one is from the root); null when it names none. */
function inputPath(input: ToolInput, field: string | undefined, root: string): string | null {
  if (field === undefined) return null
  const value = input[field]
  if (typeof value !== 'string' || value.trim() === '') return null
  return posix.normalize(isAbsolute(value) ? value : posix.join(root, value))
}

/** Whether `path` is one of `folders` or inside one. */
function insideAny(path: string, folders: readonly string[]): boolean {
  return folders.some((folder) => isInside(path, sandboxFolder(folder)))
}

/**
 * Whether a call asks to run a command outside the sandbox: its input says so (`dangerouslyDisableSandbox: true`),
 * whatever reason the SDK gives, or none (`docs/sdk-notes.md` §15).
 */
export function isSandboxOverride(input: ToolInput): boolean {
  return input.dangerouslyDisableSandbox === true
}

/** The host a `WebFetch` call's URL names; null when it names none. */
function fetchedHost(input: ToolInput): string | null {
  const { url } = input
  if (typeof url !== 'string') return null
  const host = URL.parse(url)?.hostname ?? ''
  return host === '' ? null : host
}

/** Whether a call crosses the sandbox's bounds, or asks to run outside it (see the module comment). */
export function sandboxCrossing(call: SandboxedCall, scope: SandboxScope): SandboxCrossing {
  const { toolName, input } = call
  if (isSandboxOverride(input)) return SandboxCrossing.Override
  if (toolName === SANDBOX_NETWORK_TOOL) return SandboxCrossing.Boundary
  const { root, home, grants } = scope
  if (toolName === 'WebFetch') {
    const host = fetchedHost(input)
    const granted = host !== null && grants.domains.some((domain) => hostMatches(host, domain))
    return granted ? SandboxCrossing.None : SandboxCrossing.Boundary
  }
  const read = inputPath(input, READ_PATHS[toolName], root)
  if (read !== null) {
    const bounded = insideAny(read, [home, ...DENIED_READ_ROOTS])
    const readable = insideAny(read, [root, ...grants.folders.map(({ path }) => path)])
    return bounded && !readable ? SandboxCrossing.Boundary : SandboxCrossing.None
  }
  const written = inputPath(input, WRITE_PATHS[toolName], root)
  if (written !== null) {
    const writable = grants.folders.filter(({ access }) => access === SandboxAccess.ReadWrite).map(({ path }) => path)
    return insideAny(written, [root, ...writable]) ? SandboxCrossing.None : SandboxCrossing.Boundary
  }
  return SandboxCrossing.None
}

/** What deciding a call reads of its session. */
export interface SessionScope {
  readonly permissionMode: PermissionMode
  /** Glade's own in-process MCP servers (see `permissionVerdict`). */
  readonly gladeServers: readonly string[]
  /** The sandbox the session runs in; null with the sandbox off. */
  readonly sandbox: SandboxScope | null
}

/**
 * Whether a call Claude Code asks about goes ahead, waits on you, or is refused, in its session's permission mode and
 * sandbox (see the module comment).
 */
export function toolCallVerdict(call: ClassifiedCall & SandboxedCall, session: SessionScope): PermissionVerdict {
  const { permissionMode, gladeServers, sandbox } = session
  if (sandbox !== null) {
    switch (sandboxCrossing(call, sandbox)) {
      case SandboxCrossing.Override:
        return sandbox.failed ? PermissionVerdict.Refuse : PermissionVerdict.Ask
      case SandboxCrossing.Boundary:
        return PermissionVerdict.Ask
      case SandboxCrossing.None:
        break
    }
  }
  if (permissionMode === PermissionMode.AllowAll) return PermissionVerdict.Allow
  return permissionVerdict(call, gladeServers)
}
