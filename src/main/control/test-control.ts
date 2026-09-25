// Test helpers: the app's bridge on a temporary database with the fake agent backend, and a real MCP client calling
// its `glade-control` tools over the in-memory transport, as Claude Code would.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { vi } from 'vitest'
import { z } from 'zod'
import { createBridge } from '../../preload/bridge'
import type { GladeBridge, GladeEvent } from '../../shared/bridge'
import { FakeAgentBackend } from '../agent/fake-backend'
import { registerBridge, type RegisteredBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { updateSettings } from '../db/repositories/settings'
import type { OpenPath, RevealPath, WriteClipboard } from '../files/files'
import { openTestDatabase, type TestDatabase } from '../db/repositories/test-database'
import { createMemoryLog, type MemoryLog } from '../logging/memory-sink'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import type { RateLimits } from './rate-limit'
import { ControlCallerKind, type ControlCaller } from './tools'

/** The app, as far as the control API sees it. */
export interface ControlApp {
  readonly database: TestDatabase
  readonly backend: FakeAgentBackend
  readonly bridge: RegisteredBridge
  /** The window's bridge, for doing what the UI does. */
  readonly glade: GladeBridge
  /** Every event the windows got, oldest first. */
  readonly events: GladeEvent[]
  readonly log: MemoryLog
  close(): Promise<void>
}

/** Calls as the HTTP endpoint would. */
export const HTTP: ControlCaller = { kind: ControlCallerKind.Http }

/** Calls as the task, through its own in-process server. */
export function asTask(taskId: string): ControlCaller {
  return { kind: ControlCallerKind.Task, taskId }
}

/** Starts the app's bridge on a new database, with agents allowed to control Glade unless `enabled` is false. */
export function startControlApp(enabled = true, limits?: RateLimits): ControlApp {
  const database = openTestDatabase()
  if (enabled) updateSettings(database.db, { controlEnabled: true })
  const backend = new FakeAgentBackend()
  const log = createMemoryLog()
  const ipc = fakeIpcPair()
  const bridge = registerBridge({
    ipc: ipc.main,
    db: database.db,
    targets: () => [ipc.window],
    // The desktop the window's own commands use; the control API never touches it.
    chooseFolder: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
    openPath: vi.fn<OpenPath>().mockResolvedValue(''),
    revealPath: vi.fn<RevealPath>(),
    writeClipboard: vi.fn<WriteClipboard>().mockResolvedValue(undefined),
    terminal: fakeTerminalOptions(),
    pluginsFolder: UNREAD_PLUGINS_FOLDER,
    agentBackend: backend,
    ...(limits === undefined ? {} : { controlLimits: limits }),
    log: log.logger,
  })
  const glade = createBridge(ipc.renderer)
  const events: GladeEvent[] = []
  glade.subscribe((event) => events.push(event))
  return {
    database,
    backend,
    bridge,
    glade,
    events,
    log,
    async close() {
      bridge.runner.close()
      await bridge.endpoint.close()
      bridge.terminals.shutdown()
      database.close()
    },
  }
}

/** A tool's result, as a client reads it. */
export interface ToolReply {
  readonly isError: boolean
  /** Its `structuredContent`: the result, or `{ error: { code, message } }`. */
  readonly json: Readonly<Record<string, unknown>>
  /** Its text block, which holds the same JSON. */
  readonly text: string
}

const replySchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  structuredContent: z.record(z.string(), z.unknown()),
  isError: z.boolean().optional(),
})

/** An MCP client on a server, over the in-memory transport. */
export interface ControlClient {
  call(name: string, input?: Readonly<Record<string, unknown>>): Promise<ToolReply>
  readonly client: Client
  close(): Promise<void>
}

/** Connects a client to a server, as Claude Code connects to an in-process one. */
export async function connect(server: McpServer): Promise<ControlClient> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'glade-control-test', version: '1.0.0' })
  await client.connect(clientSide)
  return {
    client,
    async call(name, input = {}) {
      const reply = replySchema.parse(await client.callTool({ name, arguments: { ...input } }))
      return {
        isError: reply.isError ?? false,
        json: reply.structuredContent,
        text: reply.content.map((block) => block.text ?? '').join(''),
      }
    },
    close: () => client.close(),
  }
}

/** The error code of a failed call, or null when it succeeded. */
export function errorCode(reply: ToolReply): string | null {
  const error = reply.json.error
  if (!reply.isError || typeof error !== 'object' || error === null) return null
  const code: unknown = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : null
}

/** The error message of a failed call. */
export function errorMessage(reply: ToolReply): string {
  const error = reply.json.error
  const message: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'message') : undefined
  return typeof message === 'string' ? message : ''
}
