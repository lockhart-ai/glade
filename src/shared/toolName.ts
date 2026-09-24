// How the tool log names a tool call. The log stores each call's name as the SDK reports it; Glade's own tools arrive as
// `mcp__glade__<tool>`, which the user reads as just `<tool>`. Other MCP tools keep their full name, so a tool of the
// user's own never passes for one of Glade's.
const GLADE_PREFIX = 'mcp__glade__'

export function toolDisplayName(name: string): string {
  return name.startsWith(GLADE_PREFIX) && name.length > GLADE_PREFIX.length ? name.slice(GLADE_PREFIX.length) : name
}
