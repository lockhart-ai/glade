// list_tasks under load, through a real MCP client: a few hundred tasks across workspaces, paged while tasks change
// between pages, comes out with no duplicates and no gaps; and its filters and search.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Effort, TaskState, type Workspace } from '../../shared/domain'
import { createTask, updateTask } from '../db/repositories/tasks'
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
} from './test-control'

let app: ControlApp
let client: ControlClient
let workspaces: Workspace[]

beforeEach(async () => {
  app = startControlApp()
  workspaces = ['Acme API', 'Acme Web', 'Acme Docs'].map((name, index) =>
    createWorkspace(app.database.db, { name, rootPath: `/code/acme-${String(index)}` }, index),
  )
  client = await connect(app.bridge.control.server(HTTP))
})

afterEach(async () => {
  await client.close()
  await app.close()
})

/** Adds `count` tasks, spread over the workspaces, each updated at its own time; some done, some pinned. */
function addTasks(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const workspaceId = workspaces[index % workspaces.length]?.id ?? ''
    const input = { workspaceId, model: 'claude-sample-1', effort: Effort.Medium }
    const task = createTask(app.database.db, { ...input, title: `Task ${String(index)}` }, 10_000 + index * 7)
    if (index % 5 === 0) updateTask(app.database.db, task.id, { state: TaskState.Done }, 10_000 + index * 7)
    if (index % 17 === 0) updateTask(app.database.db, task.id, { pinned: true }, 10_000 + index * 7)
    return task.id
  })
}

interface Summary {
  readonly id: string
  readonly workspaceId: string
  readonly state: string
  readonly pinned: boolean
  readonly updatedAt: number
}

/** A page's tasks, as a client reads them. */
function tasksOf(json: Readonly<Record<string, unknown>>): Summary[] {
  const tasks = json.tasks
  if (!Array.isArray(tasks)) throw new Error('No tasks')
  return tasks.map((task: Summary) => task)
}

function cursorOf(json: Readonly<Record<string, unknown>>): string | null {
  return typeof json.nextCursor === 'string' ? json.nextCursor : null
}

/** Pages through a listing, running `between` after each page; answers every id listed, in order. */
async function pageThrough(
  input: Readonly<Record<string, unknown>>,
  between: (page: number) => Promise<void> = () => Promise.resolve(),
): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | null = null
  let page = 0
  do {
    const reply = await client.call(ControlToolName.ListTasks, { ...input, ...(cursor === null ? {} : { cursor }) })
    expect(reply.isError, JSON.stringify(reply.json)).toBe(false)
    ids.push(...tasksOf(reply.json).map((task) => task.id))
    cursor = cursorOf(reply.json)
    page += 1
    if (cursor !== null) await between(page)
  } while (cursor !== null)
  return ids
}

describe('list_tasks', () => {
  it('lists every task once, pinned first then newest first, across workspaces', async () => {
    addTasks(40)

    const first = await client.call(ControlToolName.ListTasks, { limit: 100 })

    const tasks = tasksOf(first.json)
    expect(tasks).toHaveLength(40)
    expect(cursorOf(first.json)).toBeNull()
    const pinned = tasks.filter((task) => task.pinned)
    expect(tasks.slice(0, pinned.length)).toEqual(pinned)
    const rest = tasks.slice(pinned.length).map((task) => task.updatedAt)
    expect(rest).toEqual([...rest].sort((a, b) => b - a))
  })

  it('pages 300 tasks with no duplicates or gaps while tasks change, move, appear and go between pages', async () => {
    const initial = addTasks(300)
    const deleted = new Set<string>()
    let changes = 0

    const listed = await pageThrough({ limit: 13 }, async (page) => {
      // Tasks not listed yet jump to the top, listed ones too; one is deleted; a new one is made.
      for (const id of [initial[299 - page], initial[page * 3], initial[150 + page]]) {
        if (id === undefined || deleted.has(id)) continue
        const patch = { status: `Changed ${String(changes)}` }
        await client.call(ControlToolName.UpdateTask, { id, patch: page % 4 === 0 ? { pinned: true } : patch })
        changes += 1
      }
      const doomed = initial[(page * 11) % 300]
      if (doomed !== undefined && !deleted.has(doomed)) {
        await client.call(ControlToolName.DeleteTask, { id: doomed, confirm: true })
        deleted.add(doomed)
      }
      await client.call(ControlToolName.CreateTask, { workspaceId: workspaces[page % 3]?.id })
      if (page % 3 === 0) await client.call(ControlToolName.MarkDone, { id: initial[200 - page] })
    })

    expect(changes).toBeGreaterThan(50)
    // No duplicates; every task there from start to end listed; nothing listed that wasn't there at the start (a task
    // deleted once its page was read was listed, one deleted before wasn't).
    expect(new Set(listed).size).toBe(listed.length)
    const kept = initial.filter((id) => !deleted.has(id))
    expect(kept.filter((id) => !listed.includes(id))).toEqual([])
    expect(listed.filter((id) => !initial.includes(id))).toEqual([])
    expect(listed.length).toBeLessThan(initial.length)
  })

  it('lists one workspace, and the active or done tasks alone', async () => {
    addTasks(30)
    const [first] = workspaces

    const inWorkspace = tasksOf((await client.call(ControlToolName.ListTasks, { workspaceId: first?.id })).json)
    const active = await pageThrough({ state: 'active', limit: 4 })
    const done = await pageThrough({ state: 'done', limit: 4 })

    expect(inWorkspace).toHaveLength(10)
    expect(inWorkspace.every((task) => task.workspaceId === first?.id)).toBe(true)
    expect(active).toHaveLength(24)
    expect(done).toHaveLength(6)
    expect(new Set([...active, ...done]).size).toBe(30)
  })

  it('searches the full-text index, across workspaces or in one, best match first, and pages the results', async () => {
    addTasks(12)
    const [api, web] = workspaces
    const input = { model: 'claude-sample-1', effort: Effort.Medium }
    const title = createTask(app.database.db, { ...input, workspaceId: api?.id ?? '', title: 'Invoice export' }, 1)
    const objective = createTask(
      app.database.db,
      { ...input, workspaceId: web?.id ?? '', title: 'Billing', objective: 'Fix the invoice totals' },
      2,
    )
    const done = createTask(app.database.db, { ...input, workspaceId: web?.id ?? '', title: 'Old invoice bug' }, 3)
    updateTask(app.database.db, done.id, { state: TaskState.Done }, 3)

    const everywhere = await pageThrough({ query: 'invoice', limit: 1 })
    const inWeb = tasksOf(
      (await client.call(ControlToolName.ListTasks, { query: 'invoice', workspaceId: web?.id })).json,
    )
    const activeOnly = await pageThrough({ query: 'invoice', state: 'active' })
    const nothing = await client.call(ControlToolName.ListTasks, { query: '"' })

    expect(everywhere).toEqual([done.id, title.id, objective.id])
    expect(inWeb.map((task) => task.id)).toEqual([done.id, objective.id])
    expect(activeOnly).toEqual([title.id, objective.id])
    expect(nothing.json).toEqual({ tasks: [], nextCursor: null })
  })

  it('refuses a workspace that does not exist', async () => {
    const reply = await client.call(ControlToolName.ListTasks, { workspaceId: 'gone' })

    expect(errorCode(reply)).toBe(ControlErrorCode.NotFound)
  })

  it("refuses a cursor from a listing with other filters, and one that isn't a cursor", async () => {
    addTasks(10)
    const first = await client.call(ControlToolName.ListTasks, { limit: 2 })
    const cursor = cursorOf(first.json)

    const otherFilters = await client.call(ControlToolName.ListTasks, { state: 'done', cursor })
    const forged = Buffer.from(JSON.stringify({ listing: 'x', offset: -1 })).toString('base64url')
    const bad = await client.call(ControlToolName.ListTasks, { cursor: forged })
    const unknown = Buffer.from(JSON.stringify({ listing: 'x', offset: 2 })).toString('base64url')
    const expired = await client.call(ControlToolName.ListTasks, { cursor: unknown })

    expect(errorCode(otherFilters)).toBe(ControlErrorCode.InvalidInput)
    expect(errorMessage(otherFilters)).toBe('cursor: it is for a listing with other filters; list again without it')
    expect(errorMessage(bad)).toBe('cursor: not a cursor this listing gave; list again without it')
    expect(errorMessage(expired)).toBe('cursor: it has expired; list again without it')
  })
})
