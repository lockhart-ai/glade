// A backfill's true dates and ids through the control API (`docs/control-api.md`, "Dates" and "Backfilling past
// tasks"), through a real MCP client against the app's bridge on a real database: `create_task` and `update_task` with a
// status and its dates (#379), a date alone read as that day where Glade runs (#380), and a task's externalId changed
// (#382). Each checks the rows, the events the windows get and the task's place in the window's lists.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CommandName, EventType } from '../../shared/bridge'
import { TaskState, type Task, type Workspace } from '../../shared/domain'
import { getExternalId } from '../db/repositories/backfills'
import { getTask, listTasks } from '../db/repositories/tasks'
import { createWorkspace } from '../db/repositories/workspaces'
import { ControlErrorCode } from './errors'
import { ControlToolName } from './names'
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

const MARCH_12 = '2026-03-12T09:00:00Z'
const MARCH_20 = '2026-03-20T16:45:00Z'
const MARCH_18 = '2026-03-18T11:00:00Z'
const at = (iso: string): number => Date.parse(iso)

let app: ControlApp
let client: ControlClient
let workspace: Workspace
let zone: string | undefined

beforeEach(async () => {
  zone = process.env.TZ
  app = startControlApp()
  workspace = createWorkspace(app.database.db, { name: 'Acme API', rootPath: '/code/acme-api' })
  client = await connect(app.bridge.control.server(HTTP))
})

afterEach(async () => {
  await client.close()
  await app.close()
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
})

function current(id: string): Task {
  const found = getTask(app.database.db, id)
  if (found === undefined) throw new Error(`No task ${id}`)
  return found
}

/** The id of the task a reply carries. */
function idOf(reply: ToolReply): string {
  const task = reply.json.task
  if (typeof task !== 'object' || task === null || !('id' in task) || typeof task.id !== 'string') {
    throw new Error(`No task in ${reply.text}`)
  }
  return task.id
}

/** A done backfill of a past task, as a backfilling agent would make it. */
function backfill(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    workspaceId: workspace.id,
    title: 'Migrate billing webhooks to v2',
    status: 'Shipped: invoices and customers on v2; subscriptions next.',
    startedAt: MARCH_12,
    updatedAt: MARCH_20,
    state: 'done',
    externalId: 'tasks/billing',
    ...overrides,
  }
}

async function create(input: Readonly<Record<string, unknown>>): Promise<string> {
  const reply = await client.call(ControlToolName.CreateTask, input)
  expect(reply.isError, reply.text).toBe(false)
  return idOf(reply)
}

async function update(id: string, patch: Readonly<Record<string, unknown>>): Promise<ToolReply> {
  return client.call(ControlToolName.UpdateTask, { id, patch })
}

/** The Done section's titles, as the window lists it: most recently updated first. */
async function doneSection(): Promise<string[]> {
  const page = await app.glade.invoke(CommandName.TasksListDone, {
    workspaceId: workspace.id,
    after: null,
    limit: 100,
  })
  return page.tasks.map(({ title }) => title)
}

describe('create_task with a status and its dates (#379)', () => {
  it('sets the status, and dates the task and its status when it was last updated, done then', async () => {
    const id = await create(backfill())

    expect(current(id)).toMatchObject({
      status: 'Shipped: invoices and customers on v2; subscriptions next.',
      state: TaskState.Done,
      createdAt: at(MARCH_12),
      updatedAt: at(MARCH_20),
      statusUpdatedAt: at(MARCH_20),
      doneAt: at(MARCH_20),
    })
  })

  it('answers with the dates it set, as get_task reads them', async () => {
    const reply = await client.call(ControlToolName.CreateTask, backfill())

    expect(reply.json.task).toMatchObject({
      status: 'Shipped: invoices and customers on v2; subscriptions next.',
      createdAt: at(MARCH_12),
      updatedAt: at(MARCH_20),
      statusUpdatedAt: at(MARCH_20),
      doneAt: at(MARCH_20),
    })
    expect((await client.call(ControlToolName.GetTask, { id: idOf(reply) })).json.task).toEqual(reply.json.task)
  })

  it('dates the status apart when it gives statusUpdatedAt', async () => {
    const id = await create(backfill({ statusUpdatedAt: MARCH_18 }))

    expect(current(id)).toMatchObject({ updatedAt: at(MARCH_20), statusUpdatedAt: at(MARCH_18) })
  })

  it('is last updated when its status was set, given only statusUpdatedAt', async () => {
    const id = await create(backfill({ updatedAt: undefined, statusUpdatedAt: MARCH_18 }))

    expect(current(id)).toMatchObject({
      createdAt: at(MARCH_12),
      updatedAt: at(MARCH_18),
      statusUpdatedAt: at(MARCH_18),
      doneAt: at(MARCH_18),
    })
  })

  it('is last updated, and done, when it started when it gives no updatedAt, as before', async () => {
    const id = await create(backfill({ updatedAt: undefined }))

    expect(current(id)).toMatchObject({
      createdAt: at(MARCH_12),
      updatedAt: at(MARCH_12),
      statusUpdatedAt: at(MARCH_12),
      doneAt: at(MARCH_12),
    })
  })

  it('makes an active task with its dates, which stays active and starts no agent', async () => {
    const id = await create(backfill({ state: 'active' }))

    expect(current(id)).toMatchObject({
      state: TaskState.Active,
      createdAt: at(MARCH_12),
      updatedAt: at(MARCH_20),
      statusUpdatedAt: at(MARCH_20),
      doneAt: null,
    })
    expect(app.backend.sessions).toHaveLength(0)
  })

  it('dates a task with no status, leaving it with none', async () => {
    const id = await create(backfill({ status: undefined }))

    expect(current(id)).toMatchObject({ status: '', statusUpdatedAt: null, updatedAt: at(MARCH_20) })
  })

  it('stamps a status given with no dates now, as a new task does', async () => {
    const before = Date.now()
    const id = await create({ workspaceId: workspace.id, status: 'Planning.' })

    const task = current(id)
    expect(task.status).toBe('Planning.')
    expect(task.statusUpdatedAt).toBe(task.createdAt)
    expect(task.updatedAt).toBe(task.createdAt)
    expect(task.createdAt).toBeGreaterThanOrEqual(before)
  })

  it('puts each task in the Done section at its updatedAt, not when it started', async () => {
    await create(backfill({ title: 'Long one', externalId: 'a', startedAt: '2026-01-05', updatedAt: '2026-04-01' }))
    await create(backfill({ title: 'Short one', externalId: 'b', startedAt: '2026-03-01', updatedAt: '2026-03-02' }))
    await create(backfill({ title: 'Undated one', externalId: 'c', startedAt: '2026-03-15', updatedAt: undefined }))

    expect(await doneSection()).toEqual(['Long one', 'Undated one', 'Short one'])
  })

  it('changes nothing when run again with other dates: the task is returned as it is', async () => {
    const id = await create(backfill())

    const again = await client.call(ControlToolName.CreateTask, backfill({ updatedAt: MARCH_18, status: 'Other.' }))

    expect(again.json.created).toBe(false)
    expect(idOf(again)).toBe(id)
    expect(current(id)).toMatchObject({ updatedAt: at(MARCH_20), status: expect.stringMatching(/^Shipped/) as unknown })
  })

  describe('refuses, making nothing,', () => {
    async function refused(input: Readonly<Record<string, unknown>>): Promise<string> {
      const events = app.events.length
      const reply = await client.call(ControlToolName.CreateTask, input)
      expect(errorCode(reply)).toBe(ControlErrorCode.InvalidInput)
      expect(listTasks(app.database.db, workspace.id)).toHaveLength(0)
      expect(app.events.length).toBe(events)
      return errorMessage(reply)
    }

    it('dates in the future', async () => {
      expect(await refused(backfill({ updatedAt: '2999-01-01' }))).toBe('updatedAt: 2999-01-01 is in the future')
      expect(await refused(backfill({ statusUpdatedAt: '2999-01-01T00:00:00Z' }))).toBe(
        'statusUpdatedAt: 2999-01-01T00:00:00Z is in the future',
      )
    })

    it('what is no date, and a date and time without its offset', async () => {
      expect(await refused(backfill({ updatedAt: 'last week' }))).toMatch(/^updatedAt: must be an ISO 8601 date/)
      expect(await refused(backfill({ updatedAt: '2026-03-20T16:45:00' }))).toMatch(/^updatedAt: must be an ISO/)
      expect(await refused(backfill({ statusUpdatedAt: 1_773_302_400_000 }))).toMatch(/^statusUpdatedAt: must be/)
    })

    it('an updatedAt before the task started, given or not', async () => {
      expect(await refused(backfill({ updatedAt: '2026-03-11' }))).toBe(
        `updatedAt: 2026-03-11 is before the task started (${MARCH_12.replace('Z', '.000Z')})`,
      )
      // Started now, by default: a past updatedAt is before it.
      expect(await refused(backfill({ startedAt: undefined, updatedAt: MARCH_20 }))).toMatch(
        /^updatedAt: 2026-03-20T16:45:00Z is before the task started \(/,
      )
    })

    it('a statusUpdatedAt out of order, or without a status', async () => {
      expect(await refused(backfill({ statusUpdatedAt: '2026-03-01T00:00:00Z' }))).toBe(
        'statusUpdatedAt: 2026-03-01T00:00:00Z is before the task started (2026-03-12T09:00:00.000Z)',
      )
      expect(await refused(backfill({ statusUpdatedAt: '2026-03-21T00:00:00Z' }))).toBe(
        'statusUpdatedAt: 2026-03-21T00:00:00Z is after updatedAt (2026-03-20T16:45:00.000Z)',
      )
      expect(await refused(backfill({ status: undefined, statusUpdatedAt: MARCH_18 }))).toBe(
        'statusUpdatedAt: needs a status',
      )
      expect(await refused(backfill({ status: '  ' }))).toBe('status: is empty')
    })
  })
})

describe('update_task with dates (#379)', () => {
  /** A done task backfilled without its status, as the first backfill made them: dated when it started. */
  async function undated(): Promise<string> {
    return create(backfill({ status: undefined, updatedAt: undefined }))
  }

  it('sets a status at the date it gives, keeping the task at that date in the Done section', async () => {
    const id = await undated()
    const later = await create(backfill({ title: 'Later task', externalId: 'later', updatedAt: '2026-04-01' }))

    const reply = await update(id, { status: 'Shipped.', updatedAt: MARCH_20 })

    expect(reply.isError, reply.text).toBe(false)
    expect(current(id)).toMatchObject({
      status: 'Shipped.',
      updatedAt: at(MARCH_20),
      statusUpdatedAt: at(MARCH_20),
      // update_task leaves when a task was done: that's mark_done's.
      doneAt: at(MARCH_12),
    })
    expect(await doneSection()).toEqual(['Later task', 'Migrate billing webhooks to v2'])
    expect(current(later).updatedAt).toBe(new Date(2026, 3, 1, 12).getTime())
  })

  it('sets a status now, moving the task to the top, when it gives no updatedAt, as before', async () => {
    const id = await undated()
    await create(backfill({ title: 'Later task', externalId: 'later', updatedAt: '2026-04-01' }))
    const before = Date.now()

    await update(id, { status: 'Shipped.' })

    expect(current(id).updatedAt).toBeGreaterThanOrEqual(before)
    expect(current(id).statusUpdatedAt).toBe(current(id).updatedAt)
    expect(await doneSection()).toEqual(['Migrate billing webhooks to v2', 'Later task'])
  })

  it('dates the status apart with statusUpdatedAt', async () => {
    const id = await undated()

    await update(id, { status: 'Shipped.', statusUpdatedAt: MARCH_18, updatedAt: MARCH_20 })

    expect(current(id)).toMatchObject({ updatedAt: at(MARCH_20), statusUpdatedAt: at(MARCH_18) })
  })

  it('moves a task to a date with updatedAt alone, earlier or later, and tells the windows', async () => {
    const id = await create(backfill())
    const events = app.events.length

    await update(id, { updatedAt: '2026-03-14T08:00:00Z' })

    expect(current(id)).toMatchObject({ updatedAt: at('2026-03-14T08:00:00Z'), statusUpdatedAt: at(MARCH_20) })
    expect(app.events.slice(events).map(({ type }) => type)).toEqual([EventType.TaskUpdated])
  })

  it('keeps the date other fields would stamp when it gives updatedAt with them', async () => {
    const id = await create(backfill())

    await update(id, { title: 'Billing webhooks v2', pinned: false, updatedAt: MARCH_18 })

    expect(current(id)).toMatchObject({ title: 'Billing webhooks v2', updatedAt: at(MARCH_18) })
  })

  it("redates the task's status alone with statusUpdatedAt, keeping its place", async () => {
    const id = await create(backfill())

    await update(id, { statusUpdatedAt: MARCH_18 })

    expect(current(id)).toMatchObject({ updatedAt: at(MARCH_20), statusUpdatedAt: at(MARCH_18) })
  })

  it('leaves the status date alone when the status it gives is the one the task has', async () => {
    const id = await create(backfill({ statusUpdatedAt: MARCH_18 }))

    await update(id, { status: 'Shipped: invoices and customers on v2; subscriptions next.', updatedAt: MARCH_20 })

    expect(current(id).statusUpdatedAt).toBe(at(MARCH_18))
  })

  describe('refuses, changing nothing,', () => {
    async function refused(id: string, patch: Readonly<Record<string, unknown>>): Promise<string> {
      const before = current(id)
      const events = app.events.length
      const reply = await update(id, patch)
      expect(errorCode(reply)).toBe(ControlErrorCode.InvalidInput)
      expect(current(id)).toEqual(before)
      expect(getExternalId(app.database.db, id)).toBe('tasks/billing')
      expect(app.events.length).toBe(events)
      return errorMessage(reply)
    }

    it('dates in the future, or before the task started', async () => {
      const id = await create(backfill())

      expect(await refused(id, { title: 'x', updatedAt: '2999-01-01' })).toBe(
        'patch.updatedAt: 2999-01-01 is in the future',
      )
      expect(await refused(id, { updatedAt: '2026-03-01' })).toBe(
        'patch.updatedAt: 2026-03-01 is before the task started (2026-03-12T09:00:00.000Z)',
      )
      expect(await refused(id, { statusUpdatedAt: '2026-03-01T00:00:00+05:00' })).toBe(
        'patch.statusUpdatedAt: 2026-03-01T00:00:00+05:00 is before the task started (2026-03-12T09:00:00.000Z)',
      )
    })

    it('a statusUpdatedAt after the updatedAt it comes with, or for a task with no status', async () => {
      const id = await create(backfill())
      expect(await refused(id, { statusUpdatedAt: MARCH_20, updatedAt: MARCH_18 })).toBe(
        'patch.statusUpdatedAt: 2026-03-20T16:45:00Z is after patch.updatedAt (2026-03-18T11:00:00.000Z)',
      )
      const blank = await create(backfill({ externalId: 'blank', status: undefined }))
      const before = current(blank)
      const reply = await update(blank, { statusUpdatedAt: MARCH_18 })
      expect(errorMessage(reply)).toBe('patch.statusUpdatedAt: the task has no status')
      expect(current(blank)).toEqual(before)
    })

    it('what is no date, and a new externalId with a bad date', async () => {
      const id = await create(backfill())

      expect(await refused(id, { updatedAt: 'Tuesday' })).toMatch(/^patch\.updatedAt: must be an ISO 8601 date/)
      expect(await refused(id, { externalId: 'tasks/done/billing', updatedAt: '2999-01-01' })).toBe(
        'patch.updatedAt: 2999-01-01 is in the future',
      )
    })
  })
})

describe('a date alone, wherever Glade runs (#380)', () => {
  it.each(['America/Toronto', 'Pacific/Pago_Pago', 'Pacific/Kiritimati', 'Europe/London', 'Asia/Tokyo'])(
    'is that day in %s: the day the window shows and the task is dated',
    async (tz) => {
      process.env.TZ = tz
      const id = await create(backfill({ startedAt: '2026-09-25', updatedAt: '2026-09-26', status: undefined }))

      const task = current(id)
      for (const [when, day] of [
        [task.createdAt, 25],
        [task.updatedAt, 26],
        [task.doneAt ?? 0, 26],
      ] as const) {
        expect(new Date(when).getDate()).toBe(day)
        expect(new Date(when).getHours()).toBe(12)
      }
    },
  )

  it('keeps the exact instant of a date and time with its offset, in any zone', async () => {
    process.env.TZ = 'Pacific/Pago_Pago'
    const id = await create(backfill({ startedAt: '2026-09-25T00:30:00+09:00', updatedAt: '2026-09-25T09:00:00Z' }))

    expect(current(id)).toMatchObject({
      createdAt: at('2026-09-24T15:30:00Z'),
      updatedAt: at('2026-09-25T09:00:00Z'),
    })
  })

  it('reads the dates update_task takes the same way', async () => {
    process.env.TZ = 'America/Toronto'
    const id = await create(backfill())

    await update(id, { updatedAt: '2026-03-21', statusUpdatedAt: '2026-03-20' })

    expect(current(id)).toMatchObject({
      updatedAt: new Date(2026, 2, 21, 12).getTime(),
      statusUpdatedAt: new Date(2026, 2, 20, 12).getTime(),
    })
    expect(current(id).updatedAt).toBe(at('2026-03-21T16:00:00Z'))
  })
})

describe('update_task changing the externalId (#382)', () => {
  it("replaces the task's externalId, keeping its place, so create_task finds it by the new one only", async () => {
    const id = await create(backfill())
    const before = current(id)
    const events = app.events.length

    const reply = await update(id, { externalId: 'tasks/done/billing' })

    expect(reply.isError, reply.text).toBe(false)
    expect(reply.json.task).toMatchObject({ externalId: 'tasks/done/billing' })
    expect(getExternalId(app.database.db, id)).toBe('tasks/done/billing')
    // Not a change the window shows: the task keeps its place, and no window is told.
    expect(current(id)).toEqual(before)
    expect(app.events.length).toBe(events)

    const found = await client.call(ControlToolName.CreateTask, backfill({ externalId: 'tasks/done/billing' }))
    expect(found.json.created).toBe(false)
    expect(idOf(found)).toBe(id)
    const old = await client.call(ControlToolName.CreateTask, backfill({ externalId: 'tasks/billing' }))
    expect(old.json.created).toBe(true)
    expect(idOf(old)).not.toBe(id)
  })

  it('gives an externalId to a task created without one', async () => {
    const id = await create({ workspaceId: workspace.id, title: 'Plain' })

    await update(id, { externalId: 'tasks/plain' })

    expect(getExternalId(app.database.db, id)).toBe('tasks/plain')
  })

  it('takes the id the task already has, changing nothing', async () => {
    const id = await create(backfill())

    const reply = await update(id, { externalId: 'tasks/billing' })

    expect(reply.isError).toBe(false)
    expect(getExternalId(app.database.db, id)).toBe('tasks/billing')
  })

  it('changes it with other fields in one call', async () => {
    const id = await create(backfill())

    await update(id, { externalId: 'tasks/done/billing', status: 'Moved.', updatedAt: MARCH_20 })

    expect(getExternalId(app.database.db, id)).toBe('tasks/done/billing')
    expect(current(id)).toMatchObject({ status: 'Moved.', updatedAt: at(MARCH_20) })
  })

  it("refuses another task's id, naming that task, and changes nothing", async () => {
    const billing = await create(backfill())
    const search = await create(backfill({ title: 'Rate limit /search', externalId: 'tasks/search' }))
    const before = current(billing)
    const events = app.events.length

    const reply = await update(billing, { externalId: 'tasks/search', title: 'Renamed' })

    expect(errorCode(reply)).toBe(ControlErrorCode.InvalidInput)
    expect(errorMessage(reply)).toBe(`patch.externalId: another task (${search}) already has tasks/search`)
    expect(getExternalId(app.database.db, billing)).toBe('tasks/billing')
    expect(getExternalId(app.database.db, search)).toBe('tasks/search')
    expect(current(billing)).toEqual(before)
    expect(app.events.length).toBe(events)
  })

  it('refuses a blank one', async () => {
    const id = await create(backfill())

    expect(errorMessage(await update(id, { externalId: ' ' }))).toBe('patch.externalId: is empty')
  })

  it('lets two tasks swap ids one step at a time, never both holding one', async () => {
    const a = await create(backfill({ externalId: 'a' }))
    const b = await create(backfill({ externalId: 'b' }))

    expect(errorCode(await update(a, { externalId: 'b' }))).toBe(ControlErrorCode.InvalidInput)
    await update(a, { externalId: 'a-moving' })
    await update(b, { externalId: 'a' })
    await update(a, { externalId: 'b' })

    expect([getExternalId(app.database.db, a), getExternalId(app.database.db, b)]).toEqual(['b', 'a'])
  })
})
