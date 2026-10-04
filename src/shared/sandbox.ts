/**
 * Sandbox grants (P15, #445, "Grants"): the folders and network domains a task's agent may use beyond its workspace
 * root, the MCP servers it may use that Glade doesn't build, and whether it may reach other agents (#515), granted for
 * one task, for every task in a workspace, or Glade-wide. Nothing is granted by default.
 */
import type { EpochMs } from './domain'
import { shortenHomePath } from './homeFolder'
import { mcpServerLabel } from './mcpServers'

/** Which tasks a grant covers. */
export enum SandboxGrantScope {
  /** Every task, in every workspace: Settings › Agent's lists. */
  Glade = 'glade',
  /** Every task in one workspace: Settings › Workspace's lists, or Allow for this workspace on a card. */
  Workspace = 'workspace',
  /** One task: Allow for this task on a card. It ends with the task. */
  Task = 'task',
}

/** What a grant lets the agent use. */
export enum SandboxGrantKind {
  Folder = 'folder',
  Domain = 'domain',
  /** An MCP server Glade doesn't build: one from the user's Claude Code config, a repo's `.mcp.json`, a connector. */
  McpServer = 'mcp_server',
  /** Other agents, reached with one of Claude Code's own tools (`OtherAgents`). */
  Agents = 'agents',
}

/**
 * The agents outside a task that one of Claude Code's own tools reaches (#515). They run outside the task's sandbox, so
 * a sandboxed agent could have one do what it may not; each is granted like an MCP server.
 */
export enum OtherAgents {
  /** `SendMessage` to anything but the task's own subagents: another Claude session on this Mac, or a remote one. */
  Sessions = 'sessions',
  /** `RemoteTrigger`: Claude's cloud agents, listed, made, changed and run. */
  Cloud = 'cloud',
}

/** How each is named where grants are listed: Settings' MCP servers lists. */
export const OTHER_AGENTS_LABELS: Readonly<Record<OtherAgents, string>> = {
  [OtherAgents.Sessions]: 'Messaging other Claude sessions',
  [OtherAgents.Cloud]: 'Cloud agents',
}

/** The tool of Claude Code's that reaches each. */
export const OTHER_AGENTS_TOOLS: Readonly<Record<OtherAgents, string>> = {
  [OtherAgents.Sessions]: 'SendMessage',
  [OtherAgents.Cloud]: 'RemoteTrigger',
}

/** What a call that reaches each does, as every permission line says it. */
export function otherAgentsPhrase(agents: OtherAgents): string {
  switch (agents) {
    case OtherAgents.Sessions:
      return 'message other Claude sessions'
    case OtherAgents.Cloud:
      return 'manage cloud agents'
  }
}

/** How a granted folder may be used: a read grants read-only, a write read-write. */
export enum FolderAccess {
  Read = 'read',
  ReadWrite = 'read_write',
}

/** The tasks a grant covers: all of them, a workspace's, or one. */
export type SandboxGrantTarget =
  | { readonly scope: SandboxGrantScope.Glade }
  | { readonly scope: SandboxGrantScope.Workspace; readonly workspaceId: string }
  | { readonly scope: SandboxGrantScope.Task; readonly taskId: string }

/**
 * A folder the agent may read, or read and write: its commands and its file tools alike. Or one file, and nothing
 * beside it (`file`): what a permission card grants when the file's folder is too much to offer (the home folder, say).
 */
export interface FolderGrant {
  readonly kind: SandboxGrantKind.Folder
  /** The folder's absolute path, with no trailing slash; the file's own path, for a single file. */
  readonly path: string
  readonly access: FolderAccess
  /** Set when the grant is for that one file: nothing else in its folder is granted. Left out for a folder. */
  readonly file?: true
}

/** A network domain the agent's commands and `WebFetch` may reach. */
export interface DomainGrant {
  readonly kind: SandboxGrantKind.Domain
  /** The host, lower case, e.g. `registry.npmjs.org`. */
  readonly domain: string
}

/**
 * An MCP server the agent may use, every tool of it (#515): one Glade doesn't build, which runs outside the sandbox
 * with whatever access it has.
 */
export interface McpServerGrant {
  readonly kind: SandboxGrantKind.McpServer
  /** The server as its tools' names carry it (`mcp__<server>__<tool>`, `./mcpServers`): what a call is matched by. */
  readonly server: string
  /** The server's name as Claude Code reported it, for showing (`claude.ai Claude Docs`); `server` when it gave none. */
  readonly name: string
}

/** Other agents the agent may reach (`OtherAgents`). */
export interface AgentsGrant {
  readonly kind: SandboxGrantKind.Agents
  readonly agents: OtherAgents
}

/** What one grant allows. */
export type Grant = FolderGrant | DomainGrant | McpServerGrant | AgentsGrant

/**
 * Which grant of a scope: a folder by its path (whatever its access), a domain, an MCP server by what its tools' names
 * carry, or which other agents.
 */
export type GrantKey =
  Pick<FolderGrant, 'kind' | 'path'> | DomainGrant | Pick<McpServerGrant, 'kind' | 'server'> | AgentsGrant

/**
 * The scopes Settings lists and edits (#451): the Glade-wide grants (Settings › Agent) and a workspace's (Settings ›
 * Workspace). A task's grants come only from its permission cards, and end with it.
 */
export type SettingsGrantTarget = Exclude<SandboxGrantTarget, { readonly scope: SandboxGrantScope.Task }>

/** Whether a scope is one Settings lists: any but a task's. */
export function isSettingsGrantTarget(target: SandboxGrantTarget): target is SettingsGrantTarget {
  return target.scope !== SandboxGrantScope.Task
}

/** What a scope Settings lists is kept under, where its grants are kept by scope: `glade`, or `workspace:<id>`. */
export function settingsGrantScopeKey(target: SettingsGrantTarget): string {
  switch (target.scope) {
    case SandboxGrantScope.Glade:
      return target.scope
    case SandboxGrantScope.Workspace:
      return `${target.scope}:${target.workspaceId}`
  }
}

/**
 * Why Settings' Add… refuses a folder, domain or MCP server the sandbox could take, as Settings shows it under the
 * list: one the scope already has, and, for a workspace, its own root or a folder inside it, which its agents can
 * already use.
 */
export const SETTINGS_GRANT_REFUSALS = {
  duplicateFolder: 'That folder is already in the list.',
  duplicateDomain: 'That domain is already in the list.',
  duplicateServer: 'That MCP server is already in the list.',
  duplicateAgents: 'That is already in the list.',
  workspaceRoot: 'That folder is the workspace root, which its agents can already use.',
  insideWorkspaceRoot: 'That folder is inside the workspace root, which its agents can already use.',
} as const

/** How a folder's access reads, in Settings' lists and their selects. */
export const FOLDER_ACCESS_LABELS: Readonly<Record<FolderAccess, string>> = {
  [FolderAccess.Read]: 'Read-only',
  [FolderAccess.ReadWrite]: 'Read-write',
}

/** One grant as stored: what it allows, the tasks it covers, and when it was first granted. */
export interface SandboxGrant {
  readonly target: SandboxGrantTarget
  readonly grant: Grant
  readonly createdAt: EpochMs
}

/** Whether `access` is at least as wide as `than`. */
export function coversAccess(access: FolderAccess, than: FolderAccess): boolean {
  return access === FolderAccess.ReadWrite || than === FolderAccess.Read
}

/**
 * The grants a task has, from all the grants that cover it (Glade-wide, its workspace's and its own), each once: a
 * folder granted more than once has the widest access any grant gives it (and is a single file only if every grant of
 * it is), and a domain, an MCP server or other agents are listed once. In the order each was first granted.
 */
export function mergeGrants(grants: readonly Grant[]): Grant[] {
  const merged = new Map<string, Grant>()
  for (const grant of grants) {
    switch (grant.kind) {
      case SandboxGrantKind.Folder: {
        const key = `folder:${grant.path}`
        const earlier = merged.get(key)
        if (earlier?.kind !== SandboxGrantKind.Folder) {
          merged.set(key, grant)
          break
        }
        const { path, access } = coversAccess(earlier.access, grant.access) ? earlier : grant
        // One path granted as a file and as a folder is a folder: the wider of the two.
        const file = earlier.file === true && grant.file === true
        merged.set(key, { kind: grant.kind, path, access, ...(file ? { file } : {}) })
        break
      }
      case SandboxGrantKind.Domain:
        if (!merged.has(`domain:${grant.domain}`)) merged.set(`domain:${grant.domain}`, grant)
        break
      case SandboxGrantKind.McpServer:
        if (!merged.has(`mcp_server:${grant.server}`)) merged.set(`mcp_server:${grant.server}`, grant)
        break
      case SandboxGrantKind.Agents:
        if (!merged.has(`agents:${grant.agents}`)) merged.set(`agents:${grant.agents}`, grant)
        break
    }
  }
  return [...merged.values()]
}

/** The task a grant may cover: its id and its workspace's. */
export interface GrantedTask {
  readonly id: string
  readonly workspaceId: string
}

/** Whether a grant to `target` covers a task: every one Glade-wide, its workspace's, or its own. */
export function grantCovers(target: SandboxGrantTarget, task: GrantedTask): boolean {
  switch (target.scope) {
    case SandboxGrantScope.Glade:
      return true
    case SandboxGrantScope.Workspace:
      return target.workspaceId === task.workspaceId
    case SandboxGrantScope.Task:
      return target.taskId === task.id
  }
}

/**
 * What applying a change to the grants did to the running sandboxed sessions it covers, by task id. A task with no
 * running session, or whose session started with the sandbox off, is in none of the lists: its next session starts with
 * its grants.
 */
export interface SandboxApplyResult {
  /** The tasks whose session has the change. */
  readonly applied: readonly string[]
  /**
   * The tasks whose session wouldn't take it, and was closed rather than left running on other bounds: each stopped on
   * the sandbox's error, and its next session starts with the grants as saved.
   */
  readonly closed: readonly string[]
  /** The tasks whose session was still applying it when the caller was answered, having waited on one task only. */
  readonly pending: readonly string[]
}

/**
 * What a sandbox permission card asks for (#450): a folder, a domain, or to run one command outside the sandbox; or
 * (#515) an MCP server Glade doesn't build, or other agents.
 */
export enum SandboxAskKind {
  Folder = 'folder',
  Domain = 'domain',
  Outside = 'outside',
  McpServer = 'mcp_server',
  Agents = 'agents',
}

/**
 * The agent wants to read, or to write to, a folder outside its grants; or one file (`file`), when the file's folder
 * is too much for a card to offer: the home folder, or a folder above it.
 */
export interface SandboxFolderAsk {
  readonly kind: SandboxAskKind.Folder
  /** The folder, or the file, a grant would name, as grants keep it: absolute, where it really is. */
  readonly path: string
  /** What a grant would give: a read asks for read-only, a write for read-write. */
  readonly access: FolderAccess
  /** Set when it asks for that one file, and nothing beside it. Left out for a folder. */
  readonly file?: true
}

/** The agent wants to reach a domain that isn't granted: a command's connection, or `WebFetch`. */
export interface SandboxDomainAsk {
  readonly kind: SandboxAskKind.Domain
  /** The host, lower case. */
  readonly domain: string
  /** The command whose connection waits on the answer; null for `WebFetch`, and when Glade can't tell which it is. */
  readonly command: string | null
  /** What the agent said that command is for; null when it didn't, or there's no command. */
  readonly commandDescription: string | null
}

/** The agent wants to run one command outside the sandbox: it can only be allowed once. */
export interface SandboxOutsideAsk {
  readonly kind: SandboxAskKind.Outside
}

/** The agent wants to use an MCP server that isn't granted: any tool of it. One card for the server, not one per tool. */
export interface SandboxServerAsk {
  readonly kind: SandboxAskKind.McpServer
  /** The server as its tools' names carry it: what a grant is kept by. */
  readonly server: string
  /** Its name as Claude Code reported it, which the card shows; `server` when it gave none. */
  readonly name: string
}

/** The agent wants to reach other agents: `SendMessage` to anything but its own subagents, or `RemoteTrigger`. */
export interface SandboxAgentsAsk {
  readonly kind: SandboxAskKind.Agents
  readonly agents: OtherAgents
}

/** What a sandbox permission request asks for. */
export type SandboxAsk = SandboxFolderAsk | SandboxDomainAsk | SandboxOutsideAsk | SandboxServerAsk | SandboxAgentsAsk

/** A request for something a grant can give: a folder, a domain, an MCP server or other agents. */
export type SandboxGrantAsk = Exclude<SandboxAsk, SandboxOutsideAsk>

/** Whether a request asks for something a grant can give; running outside the sandbox is only ever allowed once. */
export function isGrantAsk(ask: SandboxAsk): ask is SandboxGrantAsk {
  return ask.kind !== SandboxAskKind.Outside
}

/** The scopes a permission card can grant to: Glade-wide grants are made in Settings only. */
export type CardGrantScope = SandboxGrantScope.Task | SandboxGrantScope.Workspace

/** What a folder request does with its folder, as every permission line says it: "read" or "write to". */
export function folderVerb(access: FolderAccess): string {
  return access === FolderAccess.Read ? 'read' : 'write to'
}

/**
 * What a sandbox request is about, in the words every permission line uses (`docs/design/README.md`, the shield):
 * "read ~/code/acme-web", "write to ~/.cache/uv", "reach registry.npmjs.org", "run outside the sandbox", "use the
 * Gmail MCP server", "message other Claude sessions" or "manage cloud agents".
 */
export function sandboxAskPhrase(ask: SandboxAsk): string {
  switch (ask.kind) {
    case SandboxAskKind.Folder:
      return `${folderVerb(ask.access)} ${shortenHomePath(ask.path)}`
    case SandboxAskKind.Domain:
      return `reach ${ask.domain}`
    case SandboxAskKind.Outside:
      return 'run outside the sandbox'
    case SandboxAskKind.McpServer:
      return `use the ${mcpServerLabel(ask.name, ask.server)} MCP server`
    case SandboxAskKind.Agents:
      return otherAgentsPhrase(ask.agents)
  }
}

/** The grant Allow for this task or Allow for this workspace makes for a request. */
export function grantFor(ask: SandboxGrantAsk): Grant {
  switch (ask.kind) {
    case SandboxAskKind.Folder:
      return {
        kind: SandboxGrantKind.Folder,
        path: ask.path,
        access: ask.access,
        ...(ask.file === true ? { file: ask.file } : {}),
      }
    case SandboxAskKind.Domain:
      return { kind: SandboxGrantKind.Domain, domain: ask.domain }
    case SandboxAskKind.McpServer:
      return { kind: SandboxGrantKind.McpServer, server: ask.server, name: ask.name }
    case SandboxAskKind.Agents:
      return { kind: SandboxGrantKind.Agents, agents: ask.agents }
  }
}
