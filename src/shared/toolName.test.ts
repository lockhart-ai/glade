import { describe, expect, it } from 'vitest'
import { toolDisplayName } from './toolName'

describe('toolDisplayName', () => {
  it("names Glade's own tools without their MCP prefix, and every other tool as the SDK does", () => {
    expect(toolDisplayName('mcp__glade__set_title')).toBe('set_title')
    expect(toolDisplayName('mcp__glade__')).toBe('mcp__glade__')
    expect(toolDisplayName('mcp__github__create_issue')).toBe('mcp__github__create_issue')
    expect(toolDisplayName('Bash')).toBe('Bash')
  })
})
