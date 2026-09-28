// Which `update_task` patches move a task in the sidebar (#384): the sidebar's sections, and `list_tasks`, order tasks by
// `updatedAt`, newest first, so a patch that stamps it moves the task to the top of its section. Each field of the
// patch is tried alone on the oldest of three tasks, active and done, through a real MCP client against the app's
// bridge on a real database, and the table in `docs/control-api.md` ("update_task") is checked against what it did.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CommandName } from '../../shared/bridge'
import { TaskFilter } from '../../shared/attention'
import { Effort, PermissionMode, TaskState, type Task, type Workspace } from '../../shared/domain'
import { getTask, updateTask } from '../db/repositories/tasks'
import { createWorkspace } from '../db/repositories/workspaces'
import { ControlToolName } from './names'
import { CONTROL_TOOLS } from './tools'
import { connect, HTTP, startControlApp, type ControlApp, type ControlClient } from './test-control'

/** The control API's reference, whose table of `update_task`'s fields this checks. */
const REFERENCE = readFileSync(new URL('../../../docs/control-api.md', import.meta.url), 'utf8')

/** What a patch does to a task's place in the sidebar. */
enum Place {
  /** It stamps `updatedAt` now: the task goes to the top of its section. */
  Moves = 'Moves',
  /** It leaves `updatedAt` as it was: the task stays where it is. */
  Keeps = 'Keeps',
  /** It sets `updatedAt` to the date it gives: the task goes where that date puts it. */
  Sets = 'Sets',
}

const RECENT = Date.parse('2026-03-20T12:00:00Z')
const OLDER = Date.parse('2026-03-15T12:00:00Z')
const OLDEST = Date.parse('2026-03-10T12:00:00Z')
/** Between the other two tasks' dates, for `updatedAt`. */
const BETWEEN = '2026-03-17T12:00:00Z'

let app: ControlApp
let client: ControlClient
let root: string
let workspace: Workspace
/** Each task's name, by id: its title when it was made, whatever a patch renames it to. */
let names: Map<string, string>

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'glade-update-order-')))
  mkdirSync(join(root, 'notes'))
  writeFileSync(join(root, 'notes', 'plan.md'), '# Plan\n')
  app = startControlApp()
  workspace = createWorkspace(app.database.db, { name: 'Acme API', rootPath: root })
  client = await connect(app.bridge.control.server(HTTP))
  names = new Map()
})

afterEach(async () => {
  await client.close()
  await app.close()
  rmSync(root, { recursive: true, force: true })
})

/** Each field of `update_task`'s patch: a value to try it with, and what it does to the task's place. */
const FIELDS: Readonly<Record<string, { readonly value: () => unknown; readonly place: Place }>> = {
  title: { value: () => 'Renamed', place: Place.Moves },
  objective: { value: () => 'A new aim.', place: Place.Moves },
  status: { value: () => 'Half done.', place: Place.Moves },
  pinned: { value: () => true, place: Place.Moves },
  unread: { value: () => true, place: Place.Keeps },
  model: { value: () => 'claude-sonnet-5', place: Place.Moves },
  effort: { value: () => Effort.Max, place: Place.Moves },
  permissionMode: { value: () => PermissionMode.AskBeforeEdits, place: Place.Moves },
  handoff: { value: () => '## Next\n\nShip it.', place: Place.Keeps },
  artifacts: { value: () => [{ path: join(root, 'notes', 'plan.md') }], place: Place.Keeps },
  externalId: { value: () => 'tasks/done/oldest', place: Place.Keeps },
  updatedAt: { value: () => BETWEEN, place: Place.Sets },
  statusUpdatedAt: { value: () => '2026-03-12T12:00:00Z', place: Place.Keeps },
}

/** The patch's fields, as `tools/list` gives its schema. */
function patchFields(): string[] {
  const tool = CONTROL_TOOLS.find(({ name }) => name === ControlToolName.UpdateTask)
  const patch: unknown = Reflect.get(Reflect.get(tool?.inputSchema.properties ?? {}, 'patch') ?? {}, 'properties')
  return Object.keys(patch ?? {})
}

/** Makes three tasks in `state`, updated oldest to newest, the oldest with a status; answers with their ids. */
async function threeTasks(state: TaskState): Promise<{ oldest: string; older: string; recent: string }> {
  const make = async (title: string, updatedAt: number): Promise<string> => {
    const reply = await client.call(ControlToolName.CreateTask, {
      workspaceId: workspace.id,
      title,
      status: 'Started.',
      startedAt: '2026-03-01T12:00:00Z',
      state,
      externalId: `tasks/${title}`,
    })
    const id: unknown = Reflect.get(reply.json.task ?? {}, 'id')
    if (typeof id !== 'string') throw new Error(reply.text)
    updateTask(app.database.db, id, { updatedAt }, updatedAt)
    names.set(id, title)
    return id
  }
  return {
    oldest: await make('oldest', OLDEST),
    older: await make('older', OLDER),
    recent: await make('recent', RECENT),
  }
}

function nameOf(id: string): string {
  return names.get(id) ?? id
}

function current(id: string): Task {
  const found = getTask(app.database.db, id)
  if (found === undefined) throw new Error(`No task ${id}`)
  return found
}

/** The task list's order, as `list_tasks` gives it: pinned first, then newest first. */
async function listed(): Promise<string[]> {
  const reply = await client.call(ControlToolName.ListTasks, { workspaceId: workspace.id })
  const tasks: unknown = reply.json.tasks
  return Array.isArray(tasks) ? tasks.map((task: unknown) => nameOf(String(Reflect.get(task ?? {}, 'id')))) : []
}

/** The Done section's order, as the window lists it: newest first. */
async function doneSection(): Promise<string[]> {
  const page = await app.glade.invoke(CommandName.TasksListDone, {
    workspaceId: workspace.id,
    filter: TaskFilter.All,
    after: null,
    limit: 10,
  })
  return page.tasks.map(({ id }) => nameOf(id))
}

/** The order a patch leaves the three tasks in, by what it does to the oldest's place. */
function orderAfter(place: Place): string[] {
  switch (place) {
    case Place.Moves:
      return ['oldest', 'recent', 'older']
    case Place.Keeps:
      return ['recent', 'older', 'oldest']
    case Place.Sets:
      return ['recent', 'oldest', 'older']
  }
}

describe("update_task and a task's place in the sidebar", () => {
  it('knows what every field of the patch does, so a new one must be added here and to the docs', () => {
    expect(Object.keys(FIELDS).sort()).toEqual(patchFields().sort())
  })

  describe.each([TaskState.Active, TaskState.Done])('of a task %s', (state) => {
    it.each(Object.entries(FIELDS))('%s alone: as the table says', async (field, { value, place }) => {
      const { oldest } = await threeTasks(state)
      const before = current(oldest)
      const start = Date.now()

      const reply = await client.call(ControlToolName.UpdateTask, { id: oldest, patch: { [field]: value() } })

      expect(reply.isError, reply.text).toBe(false)
      const after = current(oldest)
      switch (place) {
        case Place.Moves:
          expect(after.updatedAt).toBeGreaterThanOrEqual(start)
          break
        case Place.Keeps:
          expect(after.updatedAt).toBe(before.updatedAt)
          break
        case Place.Sets:
          expect(after.updatedAt).toBe(Date.parse(BETWEEN))
          break
      }
      // A pinned task leads the list, whatever its date; the others keep the order their dates give.
      expect(await listed()).toEqual(field === 'pinned' ? ['oldest', 'recent', 'older'] : orderAfter(place))
      if (state === TaskState.Done) {
        expect(await doneSection()).toEqual(field === 'pinned' ? ['recent', 'older'] : orderAfter(place))
      }
    })
  })

  it('moves a task on a patch that sets a field to the value it already has', async () => {
    const { oldest } = await threeTasks(TaskState.Active)

    await client.call(ControlToolName.UpdateTask, { id: oldest, patch: { title: 'oldest', status: 'Started.' } })

    expect(await listed()).toEqual(['oldest', 'recent', 'older'])
    // The status is the one it had, so its date stays.
    expect(current(oldest).statusUpdatedAt).toBe(Date.parse('2026-03-01T12:00:00Z'))
  })

  it('moves a task on a patch with any field that moves it, among ones that keep it', async () => {
    const { oldest } = await threeTasks(TaskState.Active)

    await client.call(ControlToolName.UpdateTask, {
      id: oldest,
      patch: { unread: true, handoff: 'Note.', externalId: 'tasks/x', title: 'oldest' },
    })

    expect(await listed()).toEqual(['oldest', 'recent', 'older'])
  })

  it('keeps a task in place on a patch of only fields that keep it', async () => {
    const { oldest } = await threeTasks(TaskState.Active)

    await client.call(ControlToolName.UpdateTask, {
      id: oldest,
      patch: {
        unread: true,
        handoff: 'Note.',
        artifacts: [{ path: join(root, 'notes', 'plan.md') }],
        externalId: 'tasks/x',
        statusUpdatedAt: '2026-03-05T12:00:00Z',
      },
    })

    expect(current(oldest).updatedAt).toBe(OLDEST)
    expect(await listed()).toEqual(['recent', 'older', 'oldest'])
  })

  it('puts a task at the updatedAt a patch gives, whatever else the patch changes', async () => {
    const { oldest } = await threeTasks(TaskState.Active)

    await client.call(ControlToolName.UpdateTask, {
      id: oldest,
      patch: { title: 'oldest', status: 'Done.', model: 'claude-sonnet-5', updatedAt: BETWEEN },
    })

    expect(current(oldest)).toMatchObject({ updatedAt: Date.parse(BETWEEN), statusUpdatedAt: Date.parse(BETWEEN) })
    expect(await listed()).toEqual(['recent', 'oldest', 'older'])
  })
})

describe("the docs' table of update_task's fields", () => {
  /** Each row of the table: the field, and the first word of what it says the field does to the task's place. */
  function documented(): Record<string, string> {
    const section = REFERENCE.slice(REFERENCE.indexOf('### `update_task`'), REFERENCE.indexOf('### `send_message`'))
    const rows = [...section.matchAll(/^\| `(\w+)` \| (\w+)/gm)]
    return Object.fromEntries(rows.map((row): [string, string] => [String(row[1]), String(row[2])]))
  }

  it("says what each field does to the task's place, as the tests above find it", () => {
    expect(documented()).toEqual(Object.fromEntries(Object.entries(FIELDS).map(([field, { place }]) => [field, place])))
  })
})
