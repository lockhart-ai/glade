// Backfilling past tasks through the control API (`docs/control-api.md`, "Backfilling past tasks"), through a real MCP
// client over the in-memory transport, against the app's bridge on a real database, the fake agent backend and a real
// workspace folder of notes: what `create_task`, `update_task` and `get_task` do with a handoff note, artifacts, a start
// date, a done state and an external id, the rows they leave, the events the windows get, and what the agent is given.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CommandName, EventType } from '../../shared/bridge'
import { TaskFilter } from '../../shared/attention'
import { MAX_HANDOFF_BYTES, TaskActivity, TaskState, type Task, type Workspace } from '../../shared/domain'
import { settle } from '../agent/fake-backend'
import { HANDOFF_HEADING, handoffSection } from '../agent/system-prompt'
import { listArtifacts } from '../db/repositories/artifacts'
import { getExternalId, getHandoff } from '../db/repositories/backfills'
import { getTask, listTasks } from '../db/repositories/tasks'
import { createWorkspace } from '../db/repositories/workspaces'
import { checkArtifacts, startedAt } from './backfill'
import { createControl } from './control'
import { ControlErrorCode } from './errors'
import { ControlToolName } from './names'
import { createRateLimiter } from './rate-limit'
import {
  connect,
  errorCode,
  errorMessage,
  HTTP,
  startControlApp,
  type ControlApp,
  type ControlClient,
  type ToolReply,
} from './test-control'

const HANDOFF = [
  '## Where it got to',
  '',
  'The `invoice.*` handlers are on v2. `subscription.*` is still on v1.',
  '',
  '## Next',
  '',
  'Write the subscription mapping. Notes are in `notes/billing/`.',
].join('\n')

const MARCH_12 = '2026-03-12T09:00:00Z'
const MARCH_12_MS = Date.parse(MARCH_12)

let app: ControlApp
let client: ControlClient
let root: string
let outside: string
let workspace: Workspace

/** Writes a file into the workspace folder, making its folders; answers with its absolute path. */
function note(path: string, content = '# Notes\n'): string {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
  return full
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'glade-backfill-')))
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'glade-backfill-outside-')))
  app = startControlApp()
  workspace = createWorkspace(app.database.db, { name: 'Acme API', rootPath: root })
  client = await connect(app.bridge.control.server(HTTP))
})

afterEach(async () => {
  await client.close()
  await app.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

function current(id: string): Task {
  const found = getTask(app.database.db, id)
  if (found === undefined) throw new Error(`No task ${id}`)
  return found
}

/** The task a reply carries. */
function taskOf(reply: ToolReply): Readonly<Record<string, unknown>> & { readonly id: string } {
  const task = reply.json.task
  if (typeof task !== 'object' || task === null || !('id' in task) || typeof task.id !== 'string') {
    throw new Error(`No task in ${reply.text}`)
  }
  return { ...task, id: task.id }
}

/** A done backfill of the billing notes, as a backfilling agent would make it. */
function billingBackfill(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    workspaceId: workspace.id,
    title: 'Migrate billing webhooks to v2',
    objective: 'Move the billing webhook handlers to v2, then retire v1.',
    handoff: HANDOFF,
    artifacts: [
      { path: note('notes/billing/notes.md'), title: 'Migration notes' },
      { path: note('notes/billing/decisions.md') },
    ],
    startedAt: MARCH_12,
    state: 'done',
    externalId: 'notes/billing',
    ...overrides,
  }
}

function eventTypes(from: number): string[] {
  return app.events.slice(from).map((event) => event.type)
}

describe('create_task, backfilling a past task', () => {
  it('makes it done at its date, with its handoff note, artifacts and external id, and starts no agent', async () => {
    const before = app.events.length

    const reply = await client.call(ControlToolName.CreateTask, billingBackfill())

    expect(reply.isError).toBe(false)
    expect(reply.json.created).toBe(true)
    const { id } = taskOf(reply)
    expect(current(id)).toMatchObject({
      title: 'Migrate billing webhooks to v2',
      state: TaskState.Done,
      activity: TaskActivity.Waiting,
      createdAt: MARCH_12_MS,
      updatedAt: MARCH_12_MS,
      doneAt: MARCH_12_MS,
      sessionId: null,
    })
    expect(getHandoff(app.database.db, id)).toEqual({
      taskId: id,
      body: HANDOFF,
      addedAt: expect.any(Number) as unknown,
    })
    expect(getHandoff(app.database.db, id)?.addedAt).toBeGreaterThan(MARCH_12_MS)
    expect(listArtifacts(app.database.db, id).map(({ path, title }) => [path, title])).toEqual([
      ['notes/billing/notes.md', 'Migration notes'],
      ['notes/billing/decisions.md', 'decisions.md'],
    ])
    expect(getExternalId(app.database.db, id)).toBe('notes/billing')
    // It never starts its agent by itself.
    await settle()
    expect(app.backend.sessions).toHaveLength(0)
    expect(eventTypes(before)).toEqual([EventType.TaskUpdated, EventType.HandoffChanged, EventType.ArtifactsChanged])
    expect(app.events.at(-2)).toEqual({
      type: EventType.HandoffChanged,
      taskId: id,
      handoff: getHandoff(app.database.db, id),
    })
  })

  it('answers with the handoff note, the artifacts by absolute path and the external id, as get_task does', async () => {
    const created = taskOf(await client.call(ControlToolName.CreateTask, billingBackfill()))

    const read = taskOf(await client.call(ControlToolName.GetTask, { id: created.id }))

    expect(read).toEqual(created)
    expect(read).toMatchObject({
      state: TaskState.Done,
      doneAt: MARCH_12_MS,
      createdAt: MARCH_12_MS,
      handoff: { body: HANDOFF, addedAt: expect.any(Number) as unknown },
      artifacts: [
        {
          path: join(root, 'notes/billing/notes.md'),
          title: 'Migration notes',
          addedAt: expect.any(Number) as unknown,
        },
        {
          path: join(root, 'notes/billing/decisions.md'),
          title: 'decisions.md',
          addedAt: expect.any(Number) as unknown,
        },
      ],
      externalId: 'notes/billing',
    })
  })

  it("puts it in the window's Done section at its date, among the tasks done before and after it", async () => {
    const april = taskOf(
      await client.call(
        ControlToolName.CreateTask,
        billingBackfill({ externalId: 'notes/april', startedAt: '2026-04-02', artifacts: [] }),
      ),
    )
    const march = taskOf(await client.call(ControlToolName.CreateTask, billingBackfill()))
    const february = taskOf(
      await client.call(
        ControlToolName.CreateTask,
        billingBackfill({ externalId: 'notes/february', startedAt: '2026-02-20T17:30:00+01:00', artifacts: [] }),
      ),
    )

    const page = await app.glade.invoke(CommandName.TasksListDone, {
      workspaceId: workspace.id,
      filter: TaskFilter.All,
      after: null,
      limit: 10,
    })

    expect(page.tasks.map(({ id }) => id)).toEqual([april.id, march.id, february.id])
    expect(current(april.id).doneAt).toBe(Date.parse('2026-04-02'))
    expect(current(february.id).doneAt).toBe(Date.parse('2026-02-20T16:30:00Z'))
  })

  it('makes an active task that waits for its first message, when not done, and still starts no agent', async () => {
    const reply = await client.call(ControlToolName.CreateTask, billingBackfill({ state: 'active' }))

    const { id } = taskOf(reply)
    expect(current(id)).toMatchObject({ state: TaskState.Active, createdAt: MARCH_12_MS, doneAt: null })
    await settle()
    expect(app.backend.sessions).toHaveLength(0)
  })

  it('starts now, active, when it gives no date or state, and sends a first message it gives', async () => {
    const before = Date.now()
    const reply = await client.call(ControlToolName.CreateTask, {
      workspaceId: workspace.id,
      handoff: HANDOFF,
      message: "Let's pick this up.",
    })

    const { id } = taskOf(reply)
    expect(current(id).createdAt).toBeGreaterThanOrEqual(before)
    expect(current(id).state).toBe(TaskState.Active)
    expect(app.backend.sessions).toHaveLength(1)
    expect(app.backend.session.sent.map(({ text }) => text)).toEqual(["Let's pick this up."])
    expect(app.backend.session.options.systemPromptAppend).toContain(HANDOFF)
  })

  it('behaves as before with neither a message nor a handoff', async () => {
    const before = app.events.length
    const reply = await client.call(ControlToolName.CreateTask, { workspaceId: workspace.id, title: 'Plain' })

    expect(reply.json.created).toBe(true)
    expect(taskOf(reply)).toMatchObject({ handoff: null, artifacts: [], externalId: null, state: TaskState.Active })
    expect(eventTypes(before)).toEqual([EventType.TaskUpdated])
  })
})

describe('running a backfill again', () => {
  it('answers with the task it made, created: false, and changes nothing, whatever the call now says', async () => {
    const first = taskOf(await client.call(ControlToolName.CreateTask, billingBackfill()))
    const before = app.events.length

    const again = await client.call(
      ControlToolName.CreateTask,
      billingBackfill({ title: 'Something else', handoff: 'A different note', startedAt: '2026-01-01' }),
    )

    expect(again.isError).toBe(false)
    expect(again.json.created).toBe(false)
    expect(taskOf(again)).toEqual(first)
    expect(listTasks(app.database.db, workspace.id)).toHaveLength(1)
    expect(getHandoff(app.database.db, first.id)?.body).toBe(HANDOFF)
    expect(app.events.length).toBe(before)
  })

  it("finds the task even when an artifact it named isn't there any more", async () => {
    const first = taskOf(await client.call(ControlToolName.CreateTask, billingBackfill()))
    rmSync(join(root, 'notes'), { recursive: true })

    const again = await client.call(ControlToolName.CreateTask, billingBackfill({ artifacts: [] }))

    expect(again.json.created).toBe(false)
    expect(taskOf(again).id).toBe(first.id)
  })

  it('makes one task when two calls with the same external id race', async () => {
    const replies = await Promise.all([
      client.call(ControlToolName.CreateTask, billingBackfill()),
      client.call(ControlToolName.CreateTask, billingBackfill()),
    ])

    expect(replies.map((reply) => reply.json.created).sort()).toEqual([false, true])
    expect(new Set(replies.map((reply) => taskOf(reply).id)).size).toBe(1)
    expect(listTasks(app.database.db, workspace.id)).toHaveLength(1)
  })

  it('makes a task per external id, and none for a failed call, so the rerun makes it', async () => {
    const missing = await client.call(
      ControlToolName.CreateTask,
      billingBackfill({ artifacts: [{ path: join(root, 'notes/billing/gone.md') }] }),
    )
    expect(errorCode(missing)).toBe(ControlErrorCode.InvalidInput)
    expect(listTasks(app.database.db, workspace.id)).toHaveLength(0)

    const made = await client.call(ControlToolName.CreateTask, billingBackfill())
    expect(made.json.created).toBe(true)
    const other = await client.call(ControlToolName.CreateTask, billingBackfill({ externalId: 'notes/other' }))
    expect(other.json.created).toBe(true)
    expect(listTasks(app.database.db, workspace.id)).toHaveLength(2)
  })
})

describe('what a backfill refuses', () => {
  /** Calls create_task and expects it refused as invalid input, leaving no task; answers with the message. */
  async function refused(input: Readonly<Record<string, unknown>>): Promise<string> {
    const before = app.events.length
    const reply = await client.call(ControlToolName.CreateTask, input)
    expect(errorCode(reply)).toBe(ControlErrorCode.InvalidInput)
    expect(listTasks(app.database.db, workspace.id)).toHaveLength(0)
    expect(app.events.length).toBe(before)
    return errorMessage(reply)
  }

  it('takes a handoff note of exactly 32 KB of UTF-8, and refuses one a byte over', async () => {
    const full = '€'.repeat(MAX_HANDOFF_BYTES / 4) + 'a'.repeat(MAX_HANDOFF_BYTES / 4)

    expect(await refused(billingBackfill({ handoff: `${full}b` }))).toBe('handoff: is over 32768 bytes of UTF-8')
    expect(await refused(billingBackfill({ handoff: '   ' }))).toBe('handoff: is empty')

    const reply = await client.call(ControlToolName.CreateTask, billingBackfill({ handoff: full }))
    expect(reply.isError).toBe(false)
    expect(getHandoff(app.database.db, taskOf(reply).id)?.body).toBe(full)
  })

  it("refuses an artifact that isn't there, naming it and saying why", async () => {
    const gone = join(root, 'notes/billing/gone.md')

    expect(
      await refused(billingBackfill({ artifacts: [{ path: note('notes/billing/notes.md') }, { path: gone }] })),
    ).toBe(`artifacts.1.path: There's no file at ${gone}.`)
  })

  it('refuses a relative path', async () => {
    expect(await refused(billingBackfill({ artifacts: [{ path: 'notes/billing/notes.md' }] }))).toBe(
      'artifacts.0.path: must be an absolute path',
    )
  })

  it('refuses a folder, a file outside the workspace, and a link that leads out of it', async () => {
    mkdirSync(join(root, 'notes/billing'), { recursive: true })
    writeFileSync(join(outside, 'secret.md'), 'secret')
    symlinkSync(join(outside, 'secret.md'), join(root, 'notes/link.md'))

    expect(await refused(billingBackfill({ artifacts: [{ path: join(root, 'notes/billing') }] }))).toBe(
      `artifacts.0.path: There's no file at ${join(root, 'notes/billing')}.`,
    )
    expect(await refused(billingBackfill({ artifacts: [{ path: join(outside, 'secret.md') }] }))).toBe(
      `artifacts.0.path: ${join(outside, 'secret.md')} is outside the workspace (${root}).`,
    )
    expect(await refused(billingBackfill({ artifacts: [{ path: join(root, 'notes/link.md') }] }))).toBe(
      'artifacts.0.path: notes/link.md is outside the workspace',
    )
  })

  it('refuses a first message for a task created done, a start date to come, and one that is no date', async () => {
    expect(await refused(billingBackfill({ message: 'Carry on.' }))).toBe(
      'message: a task created done takes no first message; send it one with send_message to reopen it',
    )
    expect(await refused(billingBackfill({ startedAt: '2999-01-01' }))).toBe('startedAt: 2999-01-01 is in the future')
    expect(await refused(billingBackfill({ startedAt: 'last March' }))).toMatch(/^startedAt: /)
    expect(await refused(billingBackfill({ startedAt: '2026-03-12T09:00:00' }))).toMatch(/^startedAt: /)
    expect(await refused(billingBackfill({ state: 'archived' }))).toMatch(/^state: /)
    expect(await refused(billingBackfill({ externalId: ' ' }))).toBe('externalId: is empty')
  })
})

describe('picking a backfilled task up', () => {
  it('reopens a done one with the message sent to it, in a session whose prompt has the handoff note', async () => {
    const { id } = taskOf(await client.call(ControlToolName.CreateTask, billingBackfill()))

    const reply = await client.call(ControlToolName.SendMessage, { id, text: "Let's pick this up." })

    expect(reply.json.delivery).toBe('sent')
    expect(current(id).state).toBe(TaskState.Active)
    const handoff = getHandoff(app.database.db, id)
    if (handoff === undefined) throw new Error('No handoff')
    expect(app.backend.session.options.systemPromptAppend).toContain(handoffSection(handoff))
    expect(app.backend.session.sent.map(({ text }) => text)).toEqual(["Let's pick this up."])
  })
})

describe('update_task on a backfilled task', () => {
  it('replaces and clears the handoff note, leaving the task in its place, and the next session has none', async () => {
    const { id } = taskOf(await client.call(ControlToolName.CreateTask, billingBackfill()))
    const before = current(id)
    const events = app.events.length

    const replaced = await client.call(ControlToolName.UpdateTask, { id, patch: { handoff: '## Next\n\nShip it.' } })
    expect(taskOf(replaced).handoff).toEqual({ body: '## Next\n\nShip it.', addedAt: expect.any(Number) as unknown })

    const cleared = await client.call(ControlToolName.UpdateTask, { id, patch: { handoff: null } })
    expect(taskOf(cleared).handoff).toBeNull()
    expect(getHandoff(app.database.db, id)).toBeUndefined()
    expect(app.events.slice(events)).toEqual([
      {
        type: EventType.HandoffChanged,
        taskId: id,
        handoff: { taskId: id, body: '## Next\n\nShip it.', addedAt: expect.any(Number) as unknown },
      },
      { type: EventType.HandoffChanged, taskId: id, handoff: null },
    ])
    // Neither is a change to the task: it keeps its place and date in the Done section.
    expect(current(id)).toEqual(before)

    await client.call(ControlToolName.SendMessage, { id, text: 'Carry on.' })
    expect(app.backend.session.options.systemPromptAppend).not.toContain(HANDOFF_HEADING)
  })

  it('adds artifacts with its other changes, and refuses a missing one without changing anything', async () => {
    const { id } = taskOf(await client.call(ControlToolName.CreateTask, billingBackfill({ artifacts: [] })))
    const plan = note('notes/billing/plan.md')

    const reply = await client.call(ControlToolName.UpdateTask, {
      id,
      patch: { status: 'Subscriptions next.', artifacts: [{ path: plan, title: 'Plan' }] },
    })

    expect(taskOf(reply)).toMatchObject({
      status: 'Subscriptions next.',
      artifacts: [{ path: plan, title: 'Plan', addedAt: expect.any(Number) as unknown }],
    })
    expect(app.events.at(-1)).toEqual({
      type: EventType.ArtifactsChanged,
      taskId: id,
      artifacts: listArtifacts(app.database.db, id),
    })

    const before = current(id)
    const events = app.events.length
    const missing = await client.call(ControlToolName.UpdateTask, {
      id,
      patch: { title: 'Renamed', handoff: 'New', artifacts: [{ path: join(root, 'gone.md') }] },
    })
    expect(errorCode(missing)).toBe(ControlErrorCode.InvalidInput)
    expect(errorMessage(missing)).toBe(`patch.artifacts.0.path: There's no file at ${join(root, 'gone.md')}.`)
    expect(current(id)).toEqual(before)
    expect(getHandoff(app.database.db, id)?.body).toBe(HANDOFF)
    expect(app.events.length).toBe(events)
  })

  it('refuses an empty list of artifacts, a note over 32 KB, and a relative path', async () => {
    const { id } = taskOf(await client.call(ControlToolName.CreateTask, billingBackfill()))

    const empty = await client.call(ControlToolName.UpdateTask, { id, patch: { artifacts: [] } })
    expect(errorMessage(empty)).toBe('patch.artifacts: is empty')
    const huge = await client.call(ControlToolName.UpdateTask, {
      id,
      patch: { handoff: 'a'.repeat(MAX_HANDOFF_BYTES + 1) },
    })
    expect(errorMessage(huge)).toBe('patch.handoff: is over 32768 bytes of UTF-8')
    const relative = await client.call(ControlToolName.UpdateTask, { id, patch: { artifacts: [{ path: 'a.md' }] } })
    expect(errorMessage(relative)).toBe('patch.artifacts.0.path: must be an absolute path')
  })

  it("answers not_found for a task that isn't there", async () => {
    const reply = await client.call(ControlToolName.UpdateTask, { id: 'gone', patch: { handoff: null } })

    expect(errorCode(reply)).toBe(ControlErrorCode.NotFound)
  })
})

describe('a backfill of 200 tasks', () => {
  it('makes each once, in date order, within the rate limits, and running it again makes none', async () => {
    // A backfilling agent's calls come a second or so apart; the clock the limits count by moves on a second a call.
    let clock = Date.now()
    const limiter = createRateLimiter({ now: () => (clock += 1_000) })
    const control = createControl({ db: app.database.db, emit: app.bridge.emit, runner: app.bridge.runner, limiter })
    const backfiller = await connect(control.server(HTTP))
    const day = 86_400_000
    const start = Date.parse('2025-01-01T12:00:00Z')
    const backfill = (index: number) =>
      backfiller.call(ControlToolName.CreateTask, {
        workspaceId: workspace.id,
        title: `Past task ${String(index)}`,
        handoff: `## Where task ${String(index)} got to\n\nSee notes/${String(index)}/.`,
        startedAt: new Date(start + index * day).toISOString(),
        state: 'done',
        externalId: `notes/${String(index)}`,
      })

    const made = []
    for (let index = 0; index < 200; index++) made.push(await backfill(index))
    expect(made.filter((reply) => reply.isError)).toEqual([])
    expect(made.every((reply) => reply.json.created === true)).toBe(true)

    const page = await app.glade.invoke(CommandName.TasksListDone, {
      workspaceId: workspace.id,
      filter: TaskFilter.All,
      after: null,
      limit: 1_000,
    })
    expect(page.tasks.map(({ title }) => title)).toEqual(
      Array.from({ length: 200 }, (_, index) => `Past task ${String(199 - index)}`),
    )

    const again = []
    for (let index = 0; index < 200; index++) again.push(await backfill(index))
    expect(again.every((reply) => reply.json.created === false)).toBe(true)
    expect(listTasks(app.database.db, workspace.id)).toHaveLength(200)
    await backfiller.close()
  })
})

describe('checkArtifacts and startedAt', () => {
  it('refuses a relative path the schema let through, and names the field it was given', async () => {
    await expect(checkArtifacts(root, [{ path: 'a.md' }], 'files')).rejects.toThrow(
      "files.0.path: a.md isn't an absolute path",
    )
  })

  it("says what went wrong when the folder can't be read", async () => {
    const locked = join(root, 'locked')
    mkdirSync(locked)
    const file = note('locked/a.md')
    // A thrown value that isn't an Error still says what it was.
    await expect(checkArtifacts('\0', [{ path: file }], 'artifacts')).rejects.toThrow(/^artifacts\.0\.path: /)
  })

  it('reads an ISO date as UTC midnight and a date and time with its offset, and refuses a time to come', () => {
    expect(startedAt('2026-03-12', Date.parse('2026-09-25'))).toBe(Date.UTC(2026, 2, 12))
    expect(startedAt('2026-03-12T10:00:00+01:00', Date.parse('2026-09-25'))).toBe(Date.UTC(2026, 2, 12, 9))
    expect(() => startedAt('2026-09-26', Date.parse('2026-09-25'))).toThrow('startedAt: 2026-09-26 is in the future')
  })
})
