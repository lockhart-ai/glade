// How the tool log names a tool call. The log stores each call's name as the SDK reports it; Glade's own tools arrive as
// `mcp__glade__<tool>`, which the user reads as just `<tool>`. Other MCP tools keep their full name, so a tool of the
// user's own never passes for one of Glade's.
const GLADE_PREFIX = 'mcp__glade__'

/** Glade's `request_access` tool, as the SDK names it: an agent's own request for a folder the sandbox blocked (#450). */
export const REQUEST_ACCESS_TOOL = `${GLADE_PREFIX}request_access`

/**
 * Glade's `file_children` tool, as the SDK names it: what Glade tells an agent to file what it made with (P16-04,
 * `docs/sdk-notes.md` §16).
 */
export const FILE_CHILDREN_TOOL = `${GLADE_PREFIX}file_children`

export function toolDisplayName(name: string): string {
  return name.startsWith(GLADE_PREFIX) && name.length > GLADE_PREFIX.length ? name.slice(GLADE_PREFIX.length) : name
}
