import { describe, expect, it } from 'vitest'
import { FILE_CHILDREN_TOOL, REQUEST_ACCESS_TOOL, toolDisplayName } from './toolName'

describe('toolDisplayName', () => {
  it("names Glade's own tools without their MCP prefix, and every other tool as the SDK does", () => {
    expect(toolDisplayName('mcp__glade__set_title')).toBe('set_title')
    expect(toolDisplayName('mcp__glade__')).toBe('mcp__glade__')
    expect(toolDisplayName('mcp__github__create_issue')).toBe('mcp__github__create_issue')
    expect(toolDisplayName('Bash')).toBe('Bash')
  })

  it("names the tools of Glade's that others name, as the SDK does", () => {
    expect(REQUEST_ACCESS_TOOL).toBe('mcp__glade__request_access')
    expect(FILE_CHILDREN_TOOL).toBe('mcp__glade__file_children')
    expect(toolDisplayName(FILE_CHILDREN_TOOL)).toBe('file_children')
  })
})
