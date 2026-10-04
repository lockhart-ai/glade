/**
 * How the agent sandbox names an MCP server (#515, `docs/sdk-notes.md` §15, "MCP servers and other agents").
 *
 * A server has two names. Claude Code reports the one it was configured under (`claude.ai Claude Docs`, `acme-docs`):
 * in a session's `system/init`, and with each call of its tools (`mcp_server.name`). Its tools' names carry another,
 * `mcp__<server>__<tool>`, where `<server>` is that name with every character outside `[a-zA-Z0-9_-]` turned into `_`
 * (`mcp__claude_ai_Claude_Docs__read`; from the bundled CLI's own words, 2.1.283). A grant is kept by the second, the
 * **key**: it's what every call carries, and what Claude Code's own rules for a server are written with. The first is
 * only shown.
 */

/** What an MCP tool's name starts with: `mcp__<server>__<tool>`. */
export const MCP_TOOL_PREFIX = 'mcp__'

/** What separates a server from its tool in a tool's name. */
const TOOL_SEPARATOR = '__'

/** The longest key a grant is kept by, and the longest name shown: far past any real server's. */
export const MAX_SERVER_KEY = 200
export const MAX_SERVER_NAME = 120

const KEY = /^[A-Za-z0-9_-]+$/

/** Whether a string can be a server's key: only what a tool's name can carry, and not empty. */
export function isMcpServerKey(value: string): boolean {
  return value.length <= MAX_SERVER_KEY && KEY.test(value)
}

/** A server's key, from the name Claude Code reports it by: each character a tool's name can't carry becomes `_`. */
export function mcpServerKey(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_')
}

/**
 * Every key Claude Code may write for a reported name, likeliest first: the name as normalised (`mcpServerKey`), and
 * that with each run of `_` made one and none left at either end, as some versions write a connector's. Whoever asks
 * takes the one a tool's name really starts with.
 */
export function mcpServerKeys(name: string): string[] {
  const key = mcpServerKey(name)
  const collapsed = key.replace(/_+/g, '_').replace(/^_|_$/g, '')
  return [...new Set([key, collapsed])].filter(isMcpServerKey)
}

/** Whether a tool's name is one of the server's with this key: `mcp__<key>__<tool>`. */
export function isToolOfServer(toolName: string, server: string): boolean {
  const prefix = `${MCP_TOOL_PREFIX}${server}${TOOL_SEPARATOR}`
  return toolName.length > prefix.length && toolName.startsWith(prefix)
}

/** The key the first `__` after the prefix ends, when nothing says where the server's name does; null for no such name. */
function leadingKey(toolName: string): string | null {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return null
  const rest = toolName.slice(MCP_TOOL_PREFIX.length)
  // A name may start with `_`: the separator is looked for past the first character.
  const end = rest.indexOf(TOOL_SEPARATOR, 1)
  return end < 0 ? rest : rest.slice(0, end)
}

/**
 * The key of the server an MCP tool is on, from the tool's name and the name Claude Code reported its server by (null
 * when it didn't): the reported name's key when the tool's name starts with it, else the tool's name up to its first
 * `__`. So a server whose own name has `__` in it is told from a shorter-named one, as long as Claude Code says which.
 * Null for a name that isn't an MCP tool's.
 */
export function mcpServerOfTool(toolName: string, reported: string | null): string | null {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return null
  const named = reported === null ? undefined : mcpServerKeys(reported).find((key) => isToolOfServer(toolName, key))
  return named ?? leadingKey(toolName)
}

/** A control character, or one that reorders the text around it: neither is ever shown. */
const UNSHOWABLE = /[\p{Cc}‪-‮⁦-⁩]/gu

/**
 * A server's name as shown: what Claude Code reported, which is text someone else wrote (a repo's `.mcp.json`), so on
 * one line, with no control or text-direction character, and cut at `MAX_SERVER_NAME`. The key when that leaves nothing.
 */
export function mcpServerLabel(name: string, server: string): string {
  const shown = name.replace(UNSHOWABLE, ' ').replace(/\s+/g, ' ').trim()
  if (shown === '') return server
  return shown.length > MAX_SERVER_NAME ? `${shown.slice(0, MAX_SERVER_NAME - 1)}…` : shown
}

/** A server a workspace's sessions have reported: what Settings' Add… offers. */
export interface ReportedMcpServer {
  /** Its key (`mcpServerKey`). */
  readonly server: string
  /** Its name as reported, for showing. */
  readonly name: string
}
