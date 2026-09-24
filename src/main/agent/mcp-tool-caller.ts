/**
 * Calls a session's in-process MCP tools the way the SDK does: over the MCP protocol, so each call's input is checked
 * against the tool's schema and a failure comes back as a tool error. For scripted agents (the tests' fake backend and
 * the e2e test mode), which have no Claude Code process to do it for them.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import type { AgentMcpServers } from './backend'

// A tool's result, as far as a caller reads it: its text blocks, and whether it failed.
const toolResult = z.looseObject({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).default([]),
  isError: z.boolean().optional(),
})

/** What a tool call gave back, as the model would see it. */
export interface McpToolOutcome {
  /** The result's text blocks, joined. */
  readonly output: string
  readonly isError: boolean
}

/** An MCP tool's SDK name, split: `mcp__glade__set_title` is the tool `set_title` on the server `glade`. */
export interface McpToolName {
  readonly server: string
  readonly tool: string
}

/** Splits an SDK tool name, `mcp__<server>__<tool>`, into its server and tool; null for any other name. */
export function parseMcpToolName(name: string): McpToolName | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(name)
  const server = match?.[1]
  const tool = match?.[2]
  return server === undefined || tool === undefined ? null : { server, tool }
}

export interface McpToolCaller {
  /** Calls a tool by its SDK name, e.g. `mcp__glade__set_title`. Throws if there's no in-process server of that name. */
  call(name: string, input: Readonly<Record<string, unknown>>): Promise<McpToolOutcome>
  /** Disconnects from every server it has called. */
  close(): Promise<void>
}

/**
 * A caller for one session's servers. A server can only be connected once, so use one caller per set of servers, as
 * one Claude Code process would.
 */
export function createMcpToolCaller(servers: AgentMcpServers): McpToolCaller {
  const clients = new Map<string, Promise<Client>>()

  const connect = async (server: string): Promise<Client> => {
    const config = servers[server]
    if (config?.type !== 'sdk') throw new Error(`No in-process MCP server named ${server}`)
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await config.instance.connect(serverSide)
    const client = new Client({ name: 'glade-scripted-agent', version: '1.0.0' })
    await client.connect(clientSide)
    return client
  }

  const clientFor = (server: string): Promise<Client> => {
    let client = clients.get(server)
    if (client === undefined) {
      client = connect(server)
      clients.set(server, client)
    }
    return client
  }

  return {
    async call(name, input) {
      const parsed = parseMcpToolName(name)
      if (parsed === null) throw new Error(`${name} isn't an MCP tool`)
      const client = await clientFor(parsed.server)
      const result = toolResult.parse(await client.callTool({ name: parsed.tool, arguments: { ...input } }))
      const output = result.content.flatMap((block) => (block.text === undefined ? [] : [block.text])).join('\n')
      return { output, isError: result.isError ?? false }
    },

    async close() {
      const connected = await Promise.allSettled(clients.values())
      clients.clear()
      for (const client of connected) if (client.status === 'fulfilled') await client.value.close()
    },
  }
}
