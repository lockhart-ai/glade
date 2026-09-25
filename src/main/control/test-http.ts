// Test helpers for the control API's HTTP endpoint: a real MCP client over Streamable HTTP, raw requests with whatever
// headers a test needs (a browser's Origin, a rebound Host, no token), and free ports to listen on.
import { request as httpRequest } from 'node:http'
import { createServer, type Server } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import type { ControlClient, ToolReply } from './test-control'

const replySchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  structuredContent: z.record(z.string(), z.unknown()),
  isError: z.boolean().optional(),
})

/** A tool's result as a client reads it, from the result of `callTool`. */
export function toolReply(result: unknown): ToolReply {
  const reply = replySchema.parse(result)
  return {
    isError: reply.isError ?? false,
    json: reply.structuredContent,
    text: reply.content.map((block) => block.text ?? '').join(''),
  }
}

/** Connects an MCP client to the endpoint at `url` with `token`, as `claude mcp add --transport http` would. */
export async function connectHttp(url: string, token: string): Promise<ControlClient> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name: 'glade-control-http-test', version: '1.0.0' })
  await client.connect(transport)
  return {
    client,
    async call(name, input = {}) {
      return toolReply(await client.callTool({ name, arguments: { ...input } }))
    },
    close: () => client.close(),
  }
}

/** A raw request to the endpoint. */
export interface RawRequest {
  readonly port: number
  /** `/mcp` by default. */
  readonly path?: string
  /** `POST` by default. */
  readonly method?: string
  /** Sent as they are: `Host` is `127.0.0.1:<port>` unless given. */
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string | Buffer
  /** Where to connect: `127.0.0.1` by default. */
  readonly address?: string
}

/** What came back. */
export interface RawResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly body: string
}

/** Sends a raw request, with exactly the headers given. */
export function rawRequest({
  port,
  path = '/mcp',
  method = 'POST',
  headers = {},
  body,
  address = '127.0.0.1',
}: RawRequest): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: address,
        port,
        path,
        method,
        headers: { Host: `127.0.0.1:${String(port)}`, ...headers },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    outgoing.on('error', reject)
    outgoing.end(body)
  })
}

/** The headers a good request carries: the token, and the JSON types MCP asks for. */
export function goodHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
}

/** A JSON-RPC `tools/call` body. */
export function toolCallBody(name: string, input: Readonly<Record<string, unknown>> = {}, id = 1): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: input } })
}

/** A tool call's result, from a raw response's JSON-RPC body. */
export function rawToolReply(response: RawResponse): ToolReply {
  const body = z.object({ result: z.unknown() }).parse(JSON.parse(response.body))
  return toolReply(body.result)
}

/** Holds a port so nothing else can listen on it, as another app would. */
export interface HeldPort {
  readonly port: number
  release(): Promise<void>
}

/** Listens on `port` of `127.0.0.1`, or rejects when it's taken. */
function hold(port: number): Promise<HeldPort> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer()
    server.once('error', reject)
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      resolve({
        port,
        release: () =>
          new Promise((done) => {
            server.close(() => {
              done()
            })
          }),
      })
    })
  })
}

/** Takes `port`, as another app would. */
export const takePort = hold

/**
 * `count` consecutive free ports, above the ephemeral range the OS hands out, found by holding each then letting it go.
 * The first one is the port to choose; the rest are its fallbacks.
 */
export async function freePortRun(count: number): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const base = 20_000 + Math.floor(Math.random() * 20_000)
    const held: HeldPort[] = []
    try {
      for (let offset = 0; offset < count; offset += 1) held.push(await hold(base + offset))
      return base
    } catch {
      // One of them is taken: try somewhere else.
    } finally {
      for (const port of held) await port.release()
    }
  }
  throw new Error(`No ${String(count)} free ports in a row`)
}
