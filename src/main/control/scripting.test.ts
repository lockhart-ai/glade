// Scripting Glade (`docs/control-api.md`, "Scripting"): the plain JSON API beside `/mcp`, which a script calls with
// `fetch` and the token, and the variables that hand the endpoint to the scripts Glade's own agents run. The app's
// bridge on a test database with the fake agent backend, its endpoint on free ports of 127.0.0.1.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CommandName } from '../../shared/bridge'
import { controlBaseUrl, type ControlStatus } from '../../shared/control'
import { Effort, PermissionMode, TaskActivity, TaskState, type Task, type Workspace } from '../../shared/domain'
import { settle } from '../agent/fake-backend'
import { sdkOptions } from '../agent/sdk-backend'
import * as sdk from '../agent/test-sdk-messages'
import { listTasks } from '../db/repositories/tasks'
import { sampleTask, sampleWorkspace } from '../db/repositories/test-database'
import { updateSettings } from '../db/repositories/settings'
import { formatRecord, REDACTED } from '../logging/format'
import { LogLevel, LogScope } from '../logging/logger'
import { ControlEnv } from './endpoint'
import { ControlErrorCode } from './errors'
import { RefusalReason, statusOf, TOOLS_PATH } from './http'
import { ControlAccess, ControlToolName } from './names'
import { startControlApp, type ControlApp } from './test-control'
import { freePortRun } from './test-http'

let app: ControlApp
let workspace: Workspace
let base: string
let token: string

/** Turns the switch on, on a run of free ports, and answers once the endpoint listens. */
async function turnOn(target: ControlApp): Promise<ControlStatus> {
  const chosen = await freePortRun(10)
  await target.glade.invoke(CommandName.SettingsUpdate, { patch: { controlPort: chosen, controlEnabled: true } })
  return (await target.glade.invoke(CommandName.ControlStatus, {})).status
}

async function start(limits?: Readonly<Record<ControlAccess, number>>): Promise<void> {
  app = startControlApp(false, limits)
  workspace = sampleWorkspace(app.database.db)
  const status = await turnOn(app)
  if (status.port === null || status.token === null) throw new Error('Not listening')
  base = controlBaseUrl(status.port)
  token = status.token
}

afterEach(async () => {
  await app.close()
})

/** What a script's `fetch` gets back: the status, the JSON and `Retry-After`. */
interface Answer {
  readonly status: number
  readonly json: Record<string, unknown>
  readonly retryAfter: string | null
}

/** Calls a tool as a script does: `POST /v1/tools/<name>` with its input as JSON. */
async function call(name: string, input?: unknown, key: string = token): Promise<Answer> {
  const response = await fetch(`${base}${TOOLS_PATH}/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    ...(input === undefined ? {} : { body: typeof input === 'string' ? input : JSON.stringify(input) }),
  })
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
    retryAfter: response.headers.get('retry-after'),
  }
}

/** The task in an answer. */
function taskOf(answer: Answer): Task {
  return answer.json.task as Task
}

describe('the plain JSON API', () => {
  beforeEach(async () => {
    await start()
  })

  it('lists every tool, with the input schema MCP lists', async () => {
    const response = await fetch(`${base}${TOOLS_PATH}`, { headers: { Authorization: `Bearer ${token}` } })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ tools: app.bridge.control.listing })
    expect(app.bridge.control.listing.map(({ name }) => name)).toContain(ControlToolName.CreateTask)
  })

  it('does everything with fetch alone: create, read, change, finish and delete a task', async () => {
    const created = await call(ControlToolName.CreateTask, { workspaceId: workspace.id, title: 'Backfill 2024' })
    expect(created.status).toBe(200)
    const { id } = taskOf(created)

    expect((await call(ControlToolName.ListWorkspaces)).json).toMatchObject({ workspaces: [{ id: workspace.id }] })
    expect((await call(ControlToolName.ListTasks, { workspaceId: workspace.id })).json).toMatchObject({
      tasks: [{ id, title: 'Backfill 2024' }],
      nextCursor: null,
    })
    expect(taskOf(await call(ControlToolName.GetTask, { id }))).toMatchObject({ id, activity: TaskActivity.Waiting })
    const sent = await call(ControlToolName.SendMessage, { id, text: 'Start with January.' })
    expect(sent.json).toMatchObject({ delivery: 'sent' })
    app.backend.session.emit(sdk.init(), sdk.text('On it.'), sdk.result('On it.'))
    await settle()
    expect((await call(ControlToolName.GetChat, { id })).json).toMatchObject({
      turns: [{ turn: 1, messages: [{ body: 'Start with January.' }, { body: 'On it.' }] }],
    })
    expect(taskOf(await call(ControlToolName.UpdateTask, { id, patch: { pinned: true } }))).toMatchObject({
      pinned: true,
    })
    expect(taskOf(await call(ControlToolName.StopTask, { id }))).toMatchObject({ id })
    expect(taskOf(await call(ControlToolName.MarkDone, { id }))).toMatchObject({ state: TaskState.Done })
    expect(taskOf(await call(ControlToolName.ReopenTask, { id }))).toMatchObject({ state: TaskState.Active })
    expect(await call(ControlToolName.DeleteTask, { id, confirm: true })).toMatchObject({
      status: 200,
      json: { deleted: id },
    })
    expect(listTasks(app.database.db, workspace.id)).toEqual([])
    // Each call is logged as the HTTP endpoint's, however it came.
    const calls = app.log.withMessage('control call').map(({ fields }) => fields.caller)
    expect(new Set(calls)).toEqual(new Set(['http']))
  })

  it.each<[string, () => Promise<Answer>, number, string]>([
    ['input that fails its schema', () => call(ControlToolName.GetTask, { id: '' }), 400, ControlErrorCode.InvalidInput],
    ['an unknown field', () => call(ControlToolName.ListWorkspaces, { what: 1 }), 400, ControlErrorCode.InvalidInput],
    ['a body that is not JSON', () => call(ControlToolName.ListWorkspaces, '{'), 400, ControlErrorCode.InvalidInput],
    ['a body that is not an object', () => call(ControlToolName.ListWorkspaces, '[]'), 400, ControlErrorCode.InvalidInput],
    ['no such task', () => call(ControlToolName.GetTask, { id: 'nope' }), 404, ControlErrorCode.NotFound],
    ['no such tool', () => call('drop_tables', {}), 404, 'not_found'],
    ['a bad token', () => call(ControlToolName.ListWorkspaces, {}, 'wrong'), 401, 'unauthorized'],
    ['no confirm', () => call(ControlToolName.DeleteTask, { id: 'any' }), 409, ControlErrorCode.ConfirmRequired],
  ])('answers %s with its status and code', async (_what, make, status, code) => {
    const answer = await make()

    expect(answer.status).toBe(status)
    expect(answer.json).toMatchObject({ error: { code, message: expect.any(String) as unknown } })
  })

  it('answers a change the task is in no state for with 409 invalid_transition', async () => {
    const task = sampleTask(app.database.db, workspace.id)
    await call(ControlToolName.MarkDone, { id: task.id })

    const again = await call(ControlToolName.MarkDone, { id: task.id })

    expect(again).toMatchObject({ status: 409, json: { error: { code: ControlErrorCode.InvalidTransition } } })
  })

  it('answers 403 disabled for a call that arrives as the switch goes off', async () => {
    // Off in the database, before the endpoint has stopped: the call itself is refused.
    updateSettings(app.database.db, { controlEnabled: false })

    const answer = await call(ControlToolName.ListWorkspaces)

    expect(answer).toMatchObject({ status: 403, json: { error: { code: ControlErrorCode.Disabled } } })
  })

  it('refuses a wrong method, a large body and a bad Origin in its own JSON shape', async () => {
    const get = await fetch(`${base}${TOOLS_PATH}/${ControlToolName.ListWorkspaces}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST')
    expect(await get.json()).toMatchObject({ error: { code: 'method_not_allowed' } })
    const post = await fetch(`${base}${TOOLS_PATH}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    expect(post.status).toBe(405)
    expect(post.headers.get('allow')).toBe('GET')

    const big = await call(ControlToolName.ListWorkspaces, JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) }))
    expect(big).toMatchObject({ status: 413, json: { error: { code: 'too_large' } } })

    const page = await fetch(`${base}${TOOLS_PATH}`, {
      headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' },
    })
    expect(page.status).toBe(403)
    expect(await page.json()).toMatchObject({ error: { code: 'forbidden' } })
    expect(app.log.withMessage('control request refused').map(({ fields }) => fields.reason)).toEqual([
      RefusalReason.BadMethod,
      RefusalReason.BadMethod,
      RefusalReason.TooLarge,
      RefusalReason.BadOrigin,
    ])
  })

  it('backs a script that creates 400 tasks at once, quickly and within the limits', async () => {
    const titles = Array.from({ length: 400 }, (_, index) => `Imported ${String(index)}`)
    const started = Date.now()
    const answers: Answer[] = []
    // As a script would: 20 at a time.
    for (let from = 0; from < titles.length; from += 20) {
      const batch = titles.slice(from, from + 20)
      answers.push(
        ...(await Promise.all(batch.map((title) => call(ControlToolName.CreateTask, { workspaceId: workspace.id, title })))),
      )
    }

    expect(answers.map(({ status }) => status)).toEqual(titles.map(() => 200))
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(
      listTasks(app.database.db, workspace.id)
        .map(({ title }) => title)
        .sort(),
    ).toEqual([...titles].sort())
  })
})

describe('the rate limit over the plain JSON API', () => {
  it('refuses a call past it with 429, Retry-After and retryAfterMs, and lets reads by', async () => {
    await start({ [ControlAccess.Read]: 5, [ControlAccess.Change]: 3 })
    for (let index = 0; index < 3; index += 1) {
      expect((await call(ControlToolName.CreateTask, { workspaceId: workspace.id })).status).toBe(200)
    }

    const refused = await call(ControlToolName.CreateTask, { workspaceId: workspace.id })

    expect(refused.status).toBe(429)
    expect(Number(refused.retryAfter)).toBeGreaterThan(0)
    expect(refused.json).toMatchObject({
      error: { code: ControlErrorCode.RateLimited, retryAfterMs: expect.any(Number) as unknown },
    })
    expect(listTasks(app.database.db, workspace.id)).toHaveLength(3)
    expect((await call(ControlToolName.ListWorkspaces)).status).toBe(200)
  })

  it('counts the tool listing as a read, refused past the limit with 429', async () => {
    await start({ [ControlAccess.Read]: 2, [ControlAccess.Change]: 2 })
    const list = () => fetch(`${base}${TOOLS_PATH}`, { headers: { Authorization: `Bearer ${token}` } })
    expect((await list()).status).toBe(200)
    expect((await list()).status).toBe(200)

    const refused = await list()

    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await refused.json()).toMatchObject({ error: { code: 'rate_limited', retryAfterMs: expect.any(Number) as unknown } })
  })
})

describe('statusOf', () => {
  it('gives every error code a status', () => {
    expect(Object.fromEntries(Object.values(ControlErrorCode).map((code) => [code, statusOf(code)]))).toEqual({
      invalid_input: 400,
      not_found: 404,
      invalid_transition: 409,
      forbidden: 403,
      confirm_required: 409,
      rate_limited: 429,
      disabled: 403,
      internal: 500,
    })
  })
})

describe("Glade's own agents", () => {
  beforeEach(async () => {
    await start()
  })

  /** Starts a new task's session, which records the options it started with. */
  async function session(): Promise<Readonly<Record<string, string>>> {
    const task = sampleTask(app.database.db, workspace.id)
    await app.glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Go.' })
    return app.backend.session.options.env ?? {}
  }

  it('get the endpoint and its token in their environment while it listens, and not once it is off', async () => {
    expect(await session()).toEqual({ [ControlEnv.Url]: base, [ControlEnv.Token]: token })

    await app.glade.invoke(CommandName.SettingsUpdate, { patch: { controlEnabled: false } })

    expect(await session()).toEqual({})
  })

  it('get a regenerated token from their next session; one running keeps the one it started with', async () => {
    const before = await session()
    const running = app.backend.session

    const { status } = await app.glade.invoke(CommandName.ControlRegenerateToken, {})

    expect(await session()).toEqual({ [ControlEnv.Url]: base, [ControlEnv.Token]: status.token })
    expect(running.options.env).toEqual(before)
  })

  it('pass it on to Claude Code, over the login shell and under the session variables Glade sets', () => {
    const options = sdkOptions(
      {
        cwd: '/code/acme-api',
        model: 'claude-sample-1',
        effort: Effort.High,
        permissionMode: PermissionMode.AllowAll,
        resumeSessionId: null,
        systemPromptAppend: '',
        mcpServers: {},
        env: { [ControlEnv.Url]: base, [ControlEnv.Token]: token, PATH: '/overridden' },
      },
      { PATH: '/usr/bin', HOME: '/Users/sample' },
    )

    expect(options.env).toMatchObject({ PATH: '/overridden', HOME: '/Users/sample', [ControlEnv.Token]: token })
  })

  it("never log the token: the log's redaction hides it, and nothing logs it to begin with", async () => {
    await session()
    const line = formatRecord({
      time: new Date(0),
      level: LogLevel.Debug,
      scope: LogScope.Env,
      message: 'agent environment variables',
      fields: { env: { [ControlEnv.Url]: base, [ControlEnv.Token]: token } },
    })

    expect(line).toContain(base)
    expect(line).not.toContain(token)
    expect(line).toContain(`"${ControlEnv.Token}":"${REDACTED}"`)
    expect(JSON.stringify(app.log.records)).not.toContain(token)
  })
})
