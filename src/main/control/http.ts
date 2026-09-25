/**
 * The control API's HTTP endpoint (`docs/control-api.md`, "The HTTP endpoint" and "Scripting"), on `127.0.0.1` only,
 * serving the `glade-control` tools two ways from one server:
 *
 * - **`/mcp`**: Streamable HTTP MCP, stateless, for Claude Code chats and other MCP clients.
 * - **`/v1/tools`**: plain JSON, for scripts. `GET /v1/tools` lists the tools with their input schemas;
 *   `POST /v1/tools/<name>` takes a tool's input as its body and answers with the tool's result (200), or with
 *   `{ error: { code, message, retryAfterMs? } }` and a status that fits the code.
 *
 * Both call the same control API (`./control`), so a call is checked, rate limited and logged the same way whichever
 * way it came. Every request is checked before either sees it, in this order:
 *
 * 1. `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, and an `Origin`, if there is one, `http://127.0.0.1:<port>`
 *    or `http://localhost:<port>`, so a web page can't reach it by rebinding a name to 127.0.0.1 (`403`).
 * 2. `Authorization: Bearer <token>`, compared in constant time (`401`). Nothing is said about paths before this.
 * 3. The path is one of the above (`404`), with its method (`405`).
 * 4. The body is at most 1 MB (`413`) and JSON (`400`).
 * 5. The rate limit, with the endpoint as one caller: a tool call is counted by the control API itself (a
 *    `rate_limited` tool error over MCP, `429` over `/v1`); any other request (`initialize`, `tools/list`,
 *    `GET /v1/tools`) counts as a read here, and is refused over the limit with `429`.
 *
 * No CORS headers are ever sent, so a browser page can't read an answer even when it can send a request. Each refused
 * request is logged with why, never with its token.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CONTROL_PATH } from '../../shared/control'
import type { Logger } from '../logging/logger'
import type { Control } from './control'
import { ControlErrorCode, type ControlErrorBody } from './errors'
import { ControlAccess } from './names'
import type { RateLimiter } from './rate-limit'
import { tokenMatches } from './token'
import { callerKey, ControlCallerKind, type ControlCaller } from './tools'

/** The only address the endpoint listens on. */
export const CONTROL_HOST = '127.0.0.1'

/** The largest request body taken: 1 MB. */
export const MAX_BODY_BYTES = 1024 * 1024

/** The plain JSON API's tools, for scripts. */
export const TOOLS_PATH = '/v1/tools'

/**
 * How much of a body over the limit is read and thrown away before answering `413`, so the client, still sending, reads
 * the answer rather than a reset connection. Past this the connection is dropped.
 */
const DRAIN_LIMIT_BYTES = 16 * MAX_BODY_BYTES

/** The HTTP endpoint's caller, as the rate limits and the log know it. */
export const HTTP_CALLER: ControlCaller = { kind: ControlCallerKind.Http }

/** Why a request was refused before a tool saw it. */
export enum RefusalReason {
  BadHost = 'bad_host',
  BadOrigin = 'bad_origin',
  NoToken = 'no_token',
  BadToken = 'bad_token',
  NotFound = 'not_found',
  BadMethod = 'bad_method',
  TooLarge = 'too_large',
  BadJson = 'bad_json',
  RateLimited = 'rate_limited',
}

/** The status each refusal is answered with. */
const REFUSAL_STATUS: Readonly<Record<RefusalReason, number>> = {
  [RefusalReason.BadHost]: 403,
  [RefusalReason.BadOrigin]: 403,
  [RefusalReason.NoToken]: 401,
  [RefusalReason.BadToken]: 401,
  [RefusalReason.NotFound]: 404,
  [RefusalReason.BadMethod]: 405,
  [RefusalReason.TooLarge]: 413,
  [RefusalReason.BadJson]: 400,
  [RefusalReason.RateLimited]: 429,
}

/** The error code each refusal has in the plain JSON API's answer. */
const REFUSAL_CODE: Readonly<Record<RefusalReason, string>> = {
  [RefusalReason.BadHost]: 'forbidden',
  [RefusalReason.BadOrigin]: 'forbidden',
  [RefusalReason.NoToken]: 'unauthorized',
  [RefusalReason.BadToken]: 'unauthorized',
  [RefusalReason.NotFound]: 'not_found',
  [RefusalReason.BadMethod]: 'method_not_allowed',
  [RefusalReason.TooLarge]: 'too_large',
  [RefusalReason.BadJson]: ControlErrorCode.InvalidInput,
  [RefusalReason.RateLimited]: ControlErrorCode.RateLimited,
}

/** What each refusal says. */
const REFUSAL_MESSAGE: Readonly<Record<RefusalReason, string>> = {
  [RefusalReason.BadHost]: 'Forbidden: the Host header must be 127.0.0.1 or localhost, with the port',
  [RefusalReason.BadOrigin]: 'Forbidden: requests from web pages are not accepted',
  [RefusalReason.NoToken]: 'Unauthorized: send Authorization: Bearer <token> (Settings › Control)',
  [RefusalReason.BadToken]: 'Unauthorized: the token is wrong; copy the command from Settings › Control again',
  [RefusalReason.NotFound]: `Not found: the endpoints are ${CONTROL_PATH}, ${TOOLS_PATH} and ${TOOLS_PATH}/<name>`,
  [RefusalReason.BadMethod]: 'Method not allowed',
  [RefusalReason.TooLarge]: 'Payload too large: a request body may be at most 1 MB',
  [RefusalReason.BadJson]: 'Parse error: the body is not JSON',
  [RefusalReason.RateLimited]: 'Too many requests in a minute; try again later',
}

/** The status a failed tool call is answered with over the plain JSON API. */
export function statusOf(code: ControlErrorCode): number {
  switch (code) {
    case ControlErrorCode.InvalidInput:
      return 400
    case ControlErrorCode.Forbidden:
    case ControlErrorCode.Disabled:
      return 403
    case ControlErrorCode.NotFound:
      return 404
    case ControlErrorCode.InvalidTransition:
    case ControlErrorCode.ConfirmRequired:
      return 409
    case ControlErrorCode.RateLimited:
      return 429
    case ControlErrorCode.Internal:
      return 500
  }
}

/** Where a request goes. */
enum Route {
  /** `POST /mcp`: MCP. */
  Mcp = 'mcp',
  /** `GET /v1/tools`: the tools. */
  ListTools = 'list_tools',
  /** `POST /v1/tools/<name>`: a call. */
  CallTool = 'call_tool',
}

/** The method each route takes. */
const ROUTE_METHOD: Readonly<Record<Route, string>> = {
  [Route.Mcp]: 'POST',
  [Route.ListTools]: 'GET',
  [Route.CallTool]: 'POST',
}

type Target =
  { readonly route: Route.Mcp | Route.ListTools } | { readonly route: Route.CallTool; readonly tool: string }

/** Where a path goes: nowhere (null) when it's none of the endpoint's. */
function targetOf(pathname: string): Target | null {
  if (pathname === CONTROL_PATH) return { route: Route.Mcp }
  if (pathname === TOOLS_PATH) return { route: Route.ListTools }
  const call = /^\/v1\/tools\/([A-Za-z0-9_]+)$/.exec(pathname)
  return call?.[1] === undefined ? null : { route: Route.CallTool, tool: call[1] }
}

/** Whether a path is the plain JSON API's, whose answers are plain JSON rather than JSON-RPC. */
function isPlain(pathname: string): boolean {
  return pathname.startsWith('/v1/')
}

/** A refused request: why, and anything its answer adds. */
interface Refusal {
  readonly reason: RefusalReason
  readonly retryAfterMs?: number
  /** The method the path takes, for a request with another. */
  readonly allow?: string
}

export interface ControlHttpOptions {
  /** The control API: its MCP server for `/mcp`, and its calls and listing for `/v1`. */
  readonly control: Pick<Control, 'server' | 'invoke' | 'has' | 'listing'>
  /** The current token; null refuses every request. Read on each request, so a new one applies at once. */
  readonly token: () => string | null
  /** The rate limits, shared with the control API's own. */
  readonly limiter: RateLimiter
  /** Where the endpoint logs, in the `control` scope. */
  readonly log: Logger
  /** The largest request body taken; 1 MB by default. */
  readonly maxBodyBytes?: number
}

/** A listening endpoint. */
export interface ControlHttpServer {
  /** The port it's listening on. */
  readonly port: number
  /** Stops listening and drops its connections. */
  close(): Promise<void>
}

/** Whether a header's value is one of `allowed`, ignoring case. */
function isOneOf(value: string | undefined, allowed: readonly string[]): boolean {
  return value !== undefined && allowed.includes(value.toLowerCase())
}

/** The bearer token a request carries, or null without one. */
function bearerOf(request: IncomingMessage): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.authorization ?? '')
  return match?.[1] ?? null
}

/** The `Retry-After` header for a wait, in whole seconds, rounded up. */
function retryAfter(retryAfterMs: number | undefined): Record<string, string> {
  return retryAfterMs === undefined ? {} : { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) }
}

/** Answers with JSON. */
function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(body))
}

/** A refusal's answer: JSON-RPC's error shape over MCP, as the SDK's transport answers, and the plain one over `/v1`. */
function refuse(response: ServerResponse, refusal: Refusal, plain: boolean): void {
  const headers: Record<string, string> = retryAfter(refusal.retryAfterMs)
  if (refusal.reason === RefusalReason.NoToken || refusal.reason === RefusalReason.BadToken) {
    headers['WWW-Authenticate'] = 'Bearer'
  }
  if (refusal.allow !== undefined) headers.Allow = refusal.allow
  const message = REFUSAL_MESSAGE[refusal.reason]
  const body = plain
    ? {
        error: {
          code: REFUSAL_CODE[refusal.reason],
          message,
          ...(refusal.retryAfterMs === undefined ? {} : { retryAfterMs: refusal.retryAfterMs }),
        },
      }
    : { jsonrpc: '2.0', error: { code: -32000, message }, id: null }
  json(response, REFUSAL_STATUS[refusal.reason], body, headers)
}

/** The request's body: its bytes, or `too_large` once they pass `limit` (read on to `DRAIN_LIMIT_BYTES`, then dropped). */
function readBody(request: IncomingMessage, limit: number): Promise<Buffer | RefusalReason.TooLarge> {
  return new Promise((resolve, reject) => {
    if (Number(request.headers['content-length'] ?? 0) > DRAIN_LIMIT_BYTES) {
      resolve(RefusalReason.TooLarge)
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > DRAIN_LIMIT_BYTES) {
        request.destroy()
        resolve(RefusalReason.TooLarge)
      } else if (size <= limit) chunks.push(chunk)
    })
    request.on('end', () => {
      resolve(size > limit ? RefusalReason.TooLarge : Buffer.concat(chunks))
    })
    request.on('error', reject)
  })
}

/** The JSON-RPC requests a body makes, by method: one message's, or each of a batch's. */
function methodsOf(body: unknown): string[] {
  const messages: unknown[] = Array.isArray(body) ? body : [body]
  return messages.flatMap((message) => {
    if (typeof message !== 'object' || message === null) return []
    const method: unknown = Reflect.get(message, 'method')
    // Notifications (no id) and answers (no method) cost nothing.
    return typeof method === 'string' && Reflect.has(message, 'id') ? [method] : []
  })
}

/** Answers requests on `port`, once it's known: the checks, then MCP or the plain JSON API. */
function createHandler(options: ControlHttpOptions, port: () => number) {
  const { control, token, limiter, log } = options
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES

  /** Where a request goes, or the first check it fails before its body is read. */
  const check = (request: IncomingMessage, pathname: string): Target | Refusal => {
    const hosts = [`127.0.0.1:${String(port())}`, `localhost:${String(port())}`]
    if (!isOneOf(request.headers.host, hosts)) return { reason: RefusalReason.BadHost }
    const origin = request.headers.origin
    if (
      origin !== undefined &&
      !isOneOf(
        origin,
        hosts.map((host) => `http://${host}`),
      )
    ) {
      return { reason: RefusalReason.BadOrigin }
    }
    const current = token()
    const given = bearerOf(request)
    if (given === null) return { reason: RefusalReason.NoToken }
    if (current === null || !tokenMatches(given, current)) return { reason: RefusalReason.BadToken }
    const target = targetOf(pathname)
    if (target === null || (target.route === Route.CallTool && !control.has(target.tool))) {
      return { reason: RefusalReason.NotFound }
    }
    const method = ROUTE_METHOD[target.route]
    if (request.method !== method) return { reason: RefusalReason.BadMethod, allow: method }
    return target
  }

  const refused = (request: IncomingMessage, response: ServerResponse, refusal: Refusal, pathname: string): void => {
    log.warn('control request refused', {
      reason: refusal.reason,
      status: REFUSAL_STATUS[refusal.reason],
      method: request.method ?? '',
      path: targetOf(pathname) === null ? '(other)' : pathname,
    })
    refuse(response, refusal, isPlain(pathname))
  }

  /** Counts a request that isn't a tool call as a read: a refusal when it's over the limit. */
  const countRead = (): Refusal | null => {
    const rate = limiter.take(callerKey(HTTP_CALLER), ControlAccess.Read)
    return rate.ok ? null : { reason: RefusalReason.RateLimited, retryAfterMs: rate.retryAfterMs }
  }

  /** Hands a checked request to a new stateless MCP server, and closes both when it's answered. */
  const answerMcp = async (request: IncomingMessage, response: ServerResponse, body: unknown): Promise<void> => {
    const server = control.server(HTTP_CALLER)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    response.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(request, response, body)
  }

  /** Calls a tool for the plain JSON API: its result, or its error with the status that fits it. */
  const answerCall = async (response: ServerResponse, tool: string, input: unknown): Promise<void> => {
    const outcome = await control.invoke(HTTP_CALLER, tool, input)
    if (outcome.ok) {
      json(response, 200, outcome.result)
      return
    }
    const error: ControlErrorBody = outcome.error.body
    json(response, statusOf(error.code), { error }, retryAfter(error.retryAfterMs))
  }

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1')
    const target = check(request, pathname)
    if ('reason' in target) {
      // Nothing more is read of a refused request; its connection isn't kept for another.
      response.shouldKeepAlive = false
      refused(request, response, target, pathname)
      request.resume()
      return
    }
    if (target.route === Route.ListTools) {
      request.resume()
      const limited = countRead()
      if (limited === null) json(response, 200, { tools: control.listing })
      else refused(request, response, limited, pathname)
      return
    }
    const bytes = await readBody(request, maxBodyBytes)
    if (bytes === RefusalReason.TooLarge) {
      response.shouldKeepAlive = false
      refused(request, response, { reason: RefusalReason.TooLarge }, pathname)
      return
    }
    let body: unknown
    try {
      // A call with no body takes no input.
      body = target.route === Route.CallTool && bytes.length === 0 ? {} : JSON.parse(bytes.toString('utf8'))
    } catch {
      refused(request, response, { reason: RefusalReason.BadJson }, pathname)
      return
    }
    if (target.route === Route.CallTool) {
      await answerCall(response, target.tool, body)
      return
    }
    // A tool call is counted by the control API, which answers one over the limit with a tool error.
    for (const method of methodsOf(body)) {
      const limited = method === 'tools/call' ? null : countRead()
      if (limited !== null) {
        refused(request, response, limited, pathname)
        return
      }
    }
    await answerMcp(request, response, body)
  }
}

/** What listening on a port came to: listening, or taken (in use, or not ours to use). */
enum Bind {
  Listening = 'listening',
  Taken = 'taken',
}

/** Listens on `port` of `host`: taken when it's in use or not allowed, and a rejection for anything else. */
function bind(server: Server, port: number, host: string): Promise<Bind> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening)
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(Bind.Taken)
      else reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve(Bind.Listening)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ port, host, exclusive: true })
  })
}

/** Every port the endpoint could have listened on was taken. */
export class PortsTakenError extends Error {
  readonly ports: readonly number[]

  constructor(ports: readonly number[]) {
    const first = String(ports[0])
    const last = String(ports[ports.length - 1])
    super(ports.length === 1 ? `Port ${first} is in use.` : `Ports ${first}–${last} are all in use.`)
    this.name = 'PortsTakenError'
    this.ports = ports
  }
}

/**
 * Starts the endpoint on the first of `ports` that's free, on `127.0.0.1` only. Rejects with `PortsTakenError` when
 * every one is taken, and with the error for anything else that stops it listening.
 */
export async function listenControlHttp(
  options: ControlHttpOptions,
  ports: readonly number[],
  host: string = CONTROL_HOST,
): Promise<ControlHttpServer> {
  let listening = 0
  const handle = createHandler(options, () => listening)
  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      options.log.error('control request failed', { error })
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })
  for (const port of ports) {
    if ((await bind(server, port, host)) === Bind.Listening) {
      listening = (server.address() as AddressInfo).port
      return {
        port: listening,
        close: () =>
          new Promise((resolve) => {
            server.close(() => {
              resolve()
            })
            server.closeAllConnections()
          }),
      }
    }
  }
  throw new PortsTakenError(ports)
}
