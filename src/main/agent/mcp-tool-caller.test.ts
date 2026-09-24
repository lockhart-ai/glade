import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createMcpToolCaller, parseMcpToolName } from './mcp-tool-caller'

function echoServer() {
  return createSdkMcpServer({
    name: 'echo',
    tools: [
      tool('echo', 'Echo the text.', { text: z.string() }, ({ text }) =>
        Promise.resolve({
          content: [
            { type: 'text', text },
            { type: 'image', data: '', mimeType: 'image/png' },
          ],
        }),
      ),
      tool('nothing', 'Say nothing.', {}, () => Promise.resolve({ content: [] })),
      tool('fail', 'Always throw.', {}, () => Promise.reject(new Error('It broke.'))),
    ],
  })
}

describe('parseMcpToolName', () => {
  it('splits an MCP tool name into its server and tool, and rejects any other name', () => {
    expect(parseMcpToolName('mcp__glade__set_title')).toEqual({ server: 'glade', tool: 'set_title' })
    expect(parseMcpToolName('mcp__my_server__do__it')).toEqual({ server: 'my_server', tool: 'do__it' })
    expect(parseMcpToolName('Bash')).toBeNull()
    expect(parseMcpToolName('mcp__glade')).toBeNull()
  })
})

describe('createMcpToolCaller', () => {
  it("runs a tool's handler through its server and gives back its text", async () => {
    const caller = createMcpToolCaller({ echo: echoServer() })

    await expect(caller.call('mcp__echo__echo', { text: 'hello' })).resolves.toEqual({
      output: 'hello',
      isError: false,
    })
    await expect(caller.call('mcp__echo__nothing', {})).resolves.toEqual({ output: '', isError: false })
    await caller.close()
  })

  it('gives back a tool error for input that fails the schema, or a handler that throws', async () => {
    const caller = createMcpToolCaller({ echo: echoServer() })

    const invalid = await caller.call('mcp__echo__echo', { text: 42 })
    expect(invalid.isError).toBe(true)
    expect(invalid.output).toContain('Input validation error')
    await expect(caller.call('mcp__echo__fail', {})).resolves.toEqual({ output: 'It broke.', isError: true })
    await caller.close()
  })

  it('refuses a name that is not an MCP tool, or a server that is not in-process', async () => {
    const caller = createMcpToolCaller({ remote: { type: 'http', url: 'http://127.0.0.1:1/mcp' } })

    await expect(caller.call('Bash', {})).rejects.toThrow("Bash isn't an MCP tool")
    await expect(caller.call('mcp__remote__go', {})).rejects.toThrow('No in-process MCP server named remote')
    await expect(caller.call('mcp__missing__go', {})).rejects.toThrow('No in-process MCP server named missing')
    await caller.close()
  })
})
