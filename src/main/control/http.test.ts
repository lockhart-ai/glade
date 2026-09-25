// The control API over real HTTP (`docs/control-api.md`, "The HTTP endpoint"): the app's bridge on a test database
// with the fake agent backend, its endpoint listening on free ports of 127.0.0.1, and a real MCP client
// (`StreamableHTTPClientTransport`) or raw requests calling it. Every tool works; every request that fails a check is
// refused with its status before MCP sees it, and changes nothing; the rate limits hold under concurrent clients; and
// neither the token nor anything else leaves 127.0.0.1 or reaches the log.
import { request as httpRequest } from 'node:http'
import { connect as connectSocket } from 'node:net'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CommandName, EventType } from '../../shared/bridge'
import { controlUrl, type ControlStatus } from '../../shared/control'
import { TaskActivity, TaskState, type Workspace } from '../../shared/domain'
import { settle } from '../agent/fake-backend'
import * as sdk from '../agent/test-sdk-messages'
import { getTask, listTasks } from '../db/repositories/tasks'
import { sampleWorkspace } from '../db/repositories/test-database'
import { listenControlHttp, MAX_BODY_BYTES, RefusalReason, TOOLS_PATH } from './http'
import { ControlToolName } from './names'
import { Delivery } from './service'
import { errorCode, startControlApp, type ControlApp, type ControlClient } from './test-control'
import {
  connectHttp,
  freePortRun,
  goodHeaders,
  rawRequest,
  rawToolReply,
  toolCallBody,
  type RawRequest,
  type RawResponse,
} from './test-http'
import { CONTROL_TOOLS } from './tools'
import { plainChat, SESSION_ID, writeTranscript } from './claude-code/test-transcripts'
import { createRateLimiter } from './rate-limit'
import { createMemoryLog } from '../logging/memory-sink'
import { ControlAccess } from './names'

/** Small rate limits, for the tests that go past them. */
const LIMITS = { [ControlAccess.Read]: 40, [ControlAccess.Change]: 30 }

let app: ControlApp
let workspace: Workspace
let status: ControlStatus
let port: number
let token: string
const clients: ControlClient[] = []

/** The endpoint's status once it's listening. */
function listening(current: ControlStatus): { port: number; token: string; url: string } {
  if (current.port === null || current.token === null || current.url === null) throw new Error('Not listening')
  return { port: current.port, token: current.token, url: current.url }
}

/** Turns the switch on, on a run of free ports, and waits until the endpoint listens. */
async function turnOn(target: ControlApp): Promise<ControlStatus> {
  const chosen = await freePortRun(10)
  await target.glade.invoke(CommandName.SettingsUpdate, { patch: { controlPort: chosen, controlEnabled: true } })
  return (await target.glade.invoke(CommandName.ControlStatus, {})).status
}

/** A temporary folder, removed after the test. */
const folders: string[] = []
function tempFolder(prefix: string): string {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  folders.push(folder)
  return folder
}

/** Claude Code's projects folder for the test: a temporary one. */
let projects: string

beforeEach(async () => {
  projects = tempFolder('glade-http-projects-')
  app = startControlApp(false, projects)
  workspace = sampleWorkspace(app.database.db)
  status = await turnOn(app)
  ;({ port, token } = listening(status))
})

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  await app.close()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

async function http(key = token): Promise<ControlClient> {
  const client = await connectHttp(controlUrl(port), key)
  clients.push(client)
  return client
}

/** A raw request to the endpoint, with good headers unless the test changes them. */
function send(request: Partial<RawRequest> = {}): Promise<RawResponse> {
  return rawRequest({
    port,
    headers: goodHeaders(token),
    body: toolCallBody(ControlToolName.ListWorkspaces),
    ...request,
  })
}

/** A create_task call, which would add a task if it got through. */
const CREATE = (): string => toolCallBody(ControlToolName.CreateTask, { workspaceId: workspace.id, title: 'Sneaky' })

function taskCount(): number {
  return listTasks(app.database.db, workspace.id).length
}

/** The refusals logged, by reason. */
function refusals(): unknown[] {
  return app.log.withMessage('control request refused').map(({ fields }) => fields.reason)
}

describe('the tools over HTTP', () => {
  it('serves every tool the registry holds, and each one works, reaching the windows as the UI would', async () => {
    const client = await http()
    const listed = (await client.client.listTools()).tools.map(({ name }) => name)
    expect(listed).toEqual(CONTROL_TOOLS.map(({ name }) => name))
    const called = new Set<string>()
    const call = async (name: ControlToolName, input: Record<string, unknown>) => {
      called.add(name)
      const reply = await client.call(name, input)
      expect(reply.isError, reply.text).toBe(false)
      return reply.json
    }

    expect(await call(ControlToolName.ListWorkspaces, {})).toMatchObject({ workspaces: [{ id: workspace.id }] })
    const created = await call(ControlToolName.CreateTask, {
      workspaceId: workspace.id,
      title: 'Tidy the changelog',
      message: 'Tidy it.',
    })
    const id = String(Reflect.get(Object(created.task), 'id'))
    expect(created).toMatchObject({ task: { title: 'Tidy the changelog', activity: TaskActivity.Working } })
    const session = app.backend.session
    session.emit(sdk.init())
    await settle()
    expect(await call(ControlToolName.ListTasks, { workspaceId: workspace.id })).toMatchObject({
      tasks: [{ id, title: 'Tidy the changelog' }],
    })
    expect(await call(ControlToolName.GetTask, { id })).toMatchObject({ task: { id, turns: 1 } })
    expect(await call(ControlToolName.GetChat, { id })).toMatchObject({ turns: [{ turn: 1 }], totalTurns: 1 })
    expect(await call(ControlToolName.SendMessage, { id, text: 'And the README.' })).toMatchObject({
      delivery: Delivery.Queued,
    })
    session.onInterrupt = () => {
      session.emit(sdk.abortedResult())
      return Promise.resolve()
    }
    expect(await call(ControlToolName.StopTask, { id })).toMatchObject({ task: { activity: TaskActivity.Waiting } })
    expect(await call(ControlToolName.UpdateTask, { id, patch: { title: 'Tidy the docs' } })).toMatchObject({
      task: { title: 'Tidy the docs' },
    })
    expect(await call(ControlToolName.MarkDone, { id })).toMatchObject({ task: { state: TaskState.Done } })
    expect(await call(ControlToolName.ReopenTask, { id })).toMatchObject({ task: { state: TaskState.Active } })
    expect(await call(ControlToolName.DeleteTask, { id, confirm: true })).toEqual({ deleted: id })
    // A Claude Code session, started in a folder that isn't a workspace yet, listed and imported.
    const cwd = tempFolder('glade-http-acme-')
    writeTranscript(projects, cwd, plainChat(cwd).toJsonl())
    expect(await call(ControlToolName.ListClaudeCodeSessions, { imported: false })).toMatchObject({
      sessions: [{ sessionId: SESSION_ID, cwd, taskId: null }],
    })
    const imported = await call(ControlToolName.ImportClaudeCodeSession, {
      sessionId: SESSION_ID,
      createWorkspace: true,
    })
    expect(imported).toMatchObject({ imported: true, task: { state: TaskState.Done, sessionId: SESSION_ID } })

    expect([...called].sort()).toEqual([...listed].sort())
    expect(getTask(app.database.db, id)).toBeUndefined()
    const types = app.events.map(({ type }) => type)
    expect(types).toContain(EventType.TaskUpdated)
    expect(types).toContain(EventType.TaskDeleted)
  })

  it('answers a tool error as MCP does, with its code', async () => {
    const reply = await (await http()).call(ControlToolName.DeleteTask, { id: 'nope' })

    expect(errorCode(reply)).toBe('confirm_required')
  })

  it('takes localhost for the Host, and an Origin of the endpoint itself', async () => {
    for (const host of [`localhost:${String(port)}`, `LOCALHOST:${String(port)}`]) {
      expect((await send({ headers: { ...goodHeaders(token), Host: host } })).status).toBe(200)
    }
    for (const origin of [`http://127.0.0.1:${String(port)}`, `http://localhost:${String(port)}`]) {
      expect((await send({ headers: { ...goodHeaders(token), Origin: origin } })).status).toBe(200)
    }
  })

  it('never sends CORS headers', async () => {
    const response = await send({ headers: { ...goodHeaders(token), Origin: `http://localhost:${String(port)}` } })

    expect(Object.keys(response.headers).filter((name) => name.startsWith('access-control'))).toEqual([])
  })
})

describe('a refused request', () => {
  const origin = (value: string) => ({ ...goodHeaders(token), Origin: value })

  it.each<[string, () => Partial<RawRequest>, number, RefusalReason]>([
    ['no token', () => ({ headers: { ...goodHeaders(token), Authorization: '' } }), 401, RefusalReason.NoToken],
    [
      'a token of another scheme',
      () => ({ headers: { ...goodHeaders(token), Authorization: `Basic ${token}` } }),
      401,
      RefusalReason.NoToken,
    ],
    ['a wrong token', () => ({ headers: goodHeaders('wrong-token') }), 401, RefusalReason.BadToken],
    ['the token cut short', () => ({ headers: goodHeaders(token.slice(0, -1)) }), 401, RefusalReason.BadToken],
    [
      'Host: evil.example',
      () => ({ headers: { ...goodHeaders(token), Host: 'evil.example' } }),
      403,
      RefusalReason.BadHost,
    ],
    [
      'a Host on another port',
      () => ({ headers: { ...goodHeaders(token), Host: `127.0.0.1:${String(port + 1)}` } }),
      403,
      RefusalReason.BadHost,
    ],
    [
      'a Host of the bare address',
      () => ({ headers: { ...goodHeaders(token), Host: '127.0.0.1' } }),
      403,
      RefusalReason.BadHost,
    ],
    ['a foreign Origin', () => ({ headers: origin('https://evil.example') }), 403, RefusalReason.BadOrigin],
    [
      'a rebound Origin on the port',
      () => ({ headers: origin(`http://evil.example:${String(port)}`) }),
      403,
      RefusalReason.BadOrigin,
    ],
    ['an https Origin', () => ({ headers: origin(`https://127.0.0.1:${String(port)}`) }), 403, RefusalReason.BadOrigin],
    ['Origin: null', () => ({ headers: origin('null') }), 403, RefusalReason.BadOrigin],
    ['a 2 MB body', () => ({ body: Buffer.alloc(2 * MAX_BODY_BYTES, 32) }), 413, RefusalReason.TooLarge],
    ['a body just over 1 MB', () => ({ body: Buffer.alloc(MAX_BODY_BYTES + 1, 32) }), 413, RefusalReason.TooLarge],
    ['another path', () => ({ path: '/', body: CREATE() }), 404, RefusalReason.NotFound],
    ['a path under the endpoint', () => ({ path: '/mcp/tools' }), 404, RefusalReason.NotFound],
    ['a GET', () => ({ method: 'GET', body: undefined }), 405, RefusalReason.BadMethod],
    ['a DELETE', () => ({ method: 'DELETE', body: undefined }), 405, RefusalReason.BadMethod],
    ['a body that is not JSON', () => ({ body: '{"jsonrpc":' }), 400, RefusalReason.BadJson],
  ])('with %s is refused with its status, and changes nothing', async (_what, request, expected, reason) => {
    const before = taskCount()

    const response = await send({ body: CREATE(), ...request() })

    expect(response.status).toBe(expected)
    expect(JSON.parse(response.body)).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 }, id: null })
    expect(taskCount()).toBe(before)
    expect(refusals()).toEqual([reason])
  })

  it('asks for a bearer token when it has none, and says what it allows when the method is wrong', async () => {
    expect((await send({ headers: {} })).headers['www-authenticate']).toBe('Bearer')
    expect((await send({ method: 'GET' })).headers.allow).toBe('POST')
  })

  it('checks the Host before the token, so a rebound page learns nothing of it', async () => {
    const response = await send({ headers: { Host: 'evil.example' } })

    expect(response.status).toBe(403)
  })

  it('with a bad token, over the MCP client, fails to connect and changes nothing', async () => {
    await expect(http('wrong-token')).rejects.toThrow()

    expect(taskCount()).toBe(0)
  })

  it('takes a body of exactly 1 MB, as far as its size goes', async () => {
    const call = toolCallBody(ControlToolName.ListWorkspaces)
    const body = call + ' '.repeat(MAX_BODY_BYTES - call.length)

    expect((await send({ body })).status).toBe(200)
  })
})

describe('the token', () => {
  it('regenerated, is refused at once in its old form, and taken in its new one', async () => {
    const before = await http()
    const { status: next } = await app.glade.invoke(CommandName.ControlRegenerateToken, {})
    const fresh = listening(next).token
    expect(fresh).not.toBe(token)

    const old = await send({ body: CREATE() })
    expect(old.status).toBe(401)
    expect(taskCount()).toBe(0)
    // A client connected with the old token is refused from its next request.
    await expect(before.call(ControlToolName.ListWorkspaces)).rejects.toThrow()
    expect((await send({ headers: goodHeaders(fresh) })).status).toBe(200)
    // Regenerating closes nothing: the endpoint is where it was.
    expect(next.port).toBe(port)
  })

  it('never reaches the log, nor does any token tried', async () => {
    const client = await http()
    await client.call(ControlToolName.CreateTask, { workspaceId: workspace.id, message: 'Go.' })
    await send({ headers: goodHeaders('wrong-guess-of-a-token') })
    const { status: next } = await app.glade.invoke(CommandName.ControlRegenerateToken, {})
    await send({ headers: goodHeaders(token) })
    await send({ headers: goodHeaders(listening(next).token) })
    await app.glade.invoke(CommandName.SettingsUpdate, { patch: { controlEnabled: false } })

    const written = JSON.stringify(app.log.records)
    expect(app.log.records.length).toBeGreaterThan(0)
    for (const secret of [token, listening(next).token, 'wrong-guess-of-a-token']) {
      expect(written).not.toContain(secret)
    }
  })
})

/** Whether a TCP connection to `address` on the endpoint's port is taken, giving up after a second. */
function reaches(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connectSocket({ host: address, port, timeout: 1000 })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => {
      resolve(false)
    })
  })
}

describe('the address', () => {
  it('is 127.0.0.1 alone: not IPv6 loopback, nor any other interface', async () => {
    expect(app.log.withMessage('control endpoint started')[0]?.fields).toMatchObject({ host: '127.0.0.1', port })
    expect(await reaches('127.0.0.1')).toBe(true)
    expect(await reaches('::1')).toBe(false)
    const others = Object.values(networkInterfaces())
      .flat()
      .flatMap((address) =>
        address === undefined || address.internal || address.family !== 'IPv4' ? [] : [address.address],
      )
    for (const address of others) expect(await reaches(address), address).toBe(false)
  })
})

describe('a body far too large', () => {
  it('declared too large to read on, is refused at once', async () => {
    const response = await send({
      headers: { ...goodHeaders(token), 'Content-Length': String(64 * MAX_BODY_BYTES) },
    }).catch((error: unknown) => error)

    // Refused before it's sent: the answer, or the connection closed under the rest of the body.
    if (response instanceof Error) {
      expect(response).toMatchObject({ code: expect.stringMatching(/EPIPE|ECONNRESET/) as unknown })
    } else expect(response).toMatchObject({ status: 413 })
    expect(refusals()).toEqual([RefusalReason.TooLarge])
  })

  it('streamed past what is worth reading, has its connection dropped, and the endpoint carries on', async () => {
    const outcome = await new Promise<string>((resolve) => {
      const outgoing = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: { ...goodHeaders(token), Host: `127.0.0.1:${String(port)}`, 'Transfer-Encoding': 'chunked' },
          agent: false,
        },
        (response) => {
          resolve(String(response.statusCode))
          response.resume()
        },
      )
      outgoing.on('error', (error: NodeJS.ErrnoException) => {
        resolve(error.code ?? 'error')
      })
      const chunk = Buffer.alloc(MAX_BODY_BYTES, 32)
      const write = (left: number): void => {
        if (left === 0) {
          outgoing.end()
          return
        }
        if (outgoing.write(chunk)) write(left - 1)
        else
          outgoing.once('drain', () => {
            write(left - 1)
          })
      }
      write(20)
    })

    expect(outcome).toMatch(/413|EPIPE|ECONNRESET/)
    expect(refusals()).toEqual([RefusalReason.TooLarge])
    expect((await send()).status).toBe(200)
  })
})

describe('a body MCP makes no sense of', () => {
  it.each([
    ['a number', '5'],
    ['a batch with a number in it', '[5]'],
  ])('as %s is for MCP to refuse, not a crash', async (_what, body) => {
    const response = await send({ body })

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
    expect((await send()).status).toBe(200)
  })
})

describe('a request that fails inside Glade', () => {
  it('is answered 500 and logged, and the endpoint carries on', async () => {
    const log = createMemoryLog()
    const broken = await listenControlHttp(
      {
        control: {
          ...app.bridge.control,
          invoke: () => Promise.reject(new Error('the database is locked')),
        },
        token: () => token,
        limiter: createRateLimiter(),
        log: log.logger,
      },
      [0],
    )
    try {
      const request = { port: broken.port, headers: goodHeaders(token), body: '{}' }
      const response = await rawRequest({ ...request, path: `${TOOLS_PATH}/${ControlToolName.ListWorkspaces}` })

      expect(response.status).toBe(500)
      expect(log.withMessage('control request failed')).toHaveLength(1)
      expect((await rawRequest({ ...request, path: TOOLS_PATH, method: 'GET', body: undefined })).status).toBe(200)
    } finally {
      await broken.close()
    }
  })
})

describe('the switch off', () => {
  it('stops the endpoint: nothing listens, and nothing changes', async () => {
    await app.glade.invoke(CommandName.SettingsUpdate, { patch: { controlEnabled: false } })

    await expect(send({ body: CREATE() })).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    expect(taskCount()).toBe(0)
    expect((await app.glade.invoke(CommandName.ControlStatus, {})).status).toMatchObject({
      enabled: false,
      port: null,
      url: null,
    })
  })
})

describe('many clients at once', () => {
  it('each get their answers, and every change lands once', async () => {
    const many = await Promise.all(Array.from({ length: 25 }, () => http()))

    const replies = await Promise.all(
      many.map(async (client, index) => {
        const created = await client.call(ControlToolName.CreateTask, {
          workspaceId: workspace.id,
          title: `Task ${String(index)}`,
        })
        const listed = await client.call(ControlToolName.ListTasks, { workspaceId: workspace.id })
        return { created, listed }
      }),
    )

    expect(replies.every(({ created, listed }) => !created.isError && !listed.isError)).toBe(true)
    expect(
      listTasks(app.database.db, workspace.id)
        .map(({ title }) => title)
        .sort(),
    ).toEqual(Array.from({ length: 25 }, (_, index) => `Task ${String(index)}`).sort())
  })

  /** Starts the app again with small rate limits, so a test can go past them quickly. */
  async function limited(): Promise<void> {
    await app.close()
    app = startControlApp(false, undefined, LIMITS)
    workspace = sampleWorkspace(app.database.db)
    ;({ port, token } = listening(await turnOn(app)))
  }

  it('share one rate limit: changes past it are refused as tool errors, and change nothing', async () => {
    await limited()
    const limit = LIMITS[ControlAccess.Change]
    const over = 5

    const responses = await Promise.all(
      Array.from({ length: limit + over }, (_, index) =>
        send({
          body: toolCallBody(ControlToolName.CreateTask, { workspaceId: workspace.id, title: `T${String(index)}` }),
        }),
      ),
    )

    const replies = responses.map((response) => {
      expect(response.status).toBe(200)
      return rawToolReply(response)
    })
    expect(replies.filter((reply) => !reply.isError)).toHaveLength(limit)
    const refused = replies.filter((reply) => reply.isError)
    expect(refused).toHaveLength(over)
    expect(refused.every((reply) => errorCode(reply) === 'rate_limited')).toBe(true)
    expect(taskCount()).toBe(limit)
    // Reads are counted apart: they still go through.
    expect(rawToolReply(await send()).isError).toBe(false)
  })

  it('share one rate limit for requests other than calls, refused past it with 429 and when to try again', async () => {
    await limited()
    const list = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const statuses = await Promise.all(
      Array.from({ length: LIMITS[ControlAccess.Read] }, async () => (await send({ body: list })).status),
    )
    expect(statuses.every((code) => code === 200)).toBe(true)

    const refused = await send({ body: list })

    expect(refused.status).toBe(429)
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0)
    expect(refusals()).toEqual([RefusalReason.RateLimited])
    // A notification costs nothing, and still gets through.
    const notification = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect((await send({ body: notification })).status).toBe(202)
  })
})
