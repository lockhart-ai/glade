// The Done section's queries: what the window loads whole, and the pages it loads the Done section in.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskFilter } from '../../../shared/attention'
import { cursorOf, pageOfDone, type DonePageRequest } from '../../../shared/doneList'
import { TaskState, type Task, type Workspace } from '../../../shared/domain'
import { countDoneTasks, getTasks, listActiveTasks, listDoneTasks, updateTask } from './tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'

let test: TestDatabase
let workspace: Workspace

beforeEach(() => {
  test = openTestDatabase()
  workspace = sampleWorkspace(test.db)
})

afterEach(() => {
  test.close()
})

/** A task in `workspace`, changed as given, last updated at `at`. */
function task(at: number, patch: Parameters<typeof updateTask>[2] = {}, workspaceId = workspace.id): Task {
  return updateTask(test.db, sampleTask(test.db, workspaceId, at).id, patch, at)
}

function done(at: number, unread = false): Task {
  return task(at, { state: TaskState.Done, unread })
}

function ids(tasks: readonly Task[]): string[] {
  return tasks.map(({ id }) => id)
}

/** Every page of the Done section under a filter, walked from the top as the window loads them. */
function walk(filter: TaskFilter, limit: number): Task[][] {
  const pages: Task[][] = []
  let after: DonePageRequest['after'] = null
  for (;;) {
    const page = listDoneTasks(test.db, { workspaceId: workspace.id, filter, after, limit })
    pages.push([...page.tasks])
    const last = page.tasks.at(-1)
    if (!page.hasMore || last === undefined) return pages
    after = cursorOf(last)
  }
}

describe('listActiveTasks', () => {
  it("lists a workspace's active tasks and its pinned ones, whatever their state, most recently updated first", () => {
    const active = task(300)
    const pinnedDone = task(100, { state: TaskState.Done, pinned: true })
    const pinnedActive = task(200, { pinned: true })
    done(400)
    task(500, {}, sampleWorkspace(test.db, '/code/other').id)

    expect(ids(listActiveTasks(test.db, workspace.id))).toEqual([active.id, pinnedActive.id, pinnedDone.id])
  })
})

describe('countDoneTasks', () => {
  it("counts a workspace's Done section, and its unread tasks, leaving out pinned and other workspaces' tasks", () => {
    done(100)
    done(200, true)
    done(300, true)
    task(400, { state: TaskState.Done, pinned: true, unread: true })
    task(500, { unread: true })
    task(600, { state: TaskState.Done, unread: true }, sampleWorkspace(test.db, '/code/other').id)

    expect(countDoneTasks(test.db, workspace.id)).toEqual({ all: 3, unread: 2 })
  })

  it('counts none in a workspace with no done tasks', () => {
    task(100)

    expect(countDoneTasks(test.db, workspace.id)).toEqual({ all: 0, unread: 0 })
  })
})

describe('listDoneTasks', () => {
  it('lists the Done section a page at a time, most recently updated first, each page after the last', () => {
    const tasks = [done(500), done(400), done(300), done(200), done(100)]

    expect(walk(TaskFilter.All, 2).map(ids)).toEqual([
      ids(tasks.slice(0, 2)),
      ids(tasks.slice(2, 4)),
      ids(tasks.slice(4)),
    ])
  })

  it('says whether more follow: not when the last page is exactly full', () => {
    done(200)
    done(100)
    const request = { workspaceId: workspace.id, filter: TaskFilter.All, after: null, limit: 2 }

    expect(listDoneTasks(test.db, request).hasMore).toBe(false)
    expect(listDoneTasks(test.db, { ...request, limit: 1 }).hasMore).toBe(true)
  })

  it('breaks ties by id, so tasks updated at the same moment split across pages without a gap or a repeat', () => {
    const tied = Array.from({ length: 7 }, () => done(1_000)).sort((a, b) => (a.id < b.id ? -1 : 1))

    const pages = walk(TaskFilter.All, 3)

    expect(pages.map((page) => page.length)).toEqual([3, 3, 1])
    expect(pages.flat().map(({ id }) => id)).toEqual(ids(tied))
  })

  it('leaves out pinned tasks, active ones and other workspaces’ tasks', () => {
    const listed = done(100)
    task(200, { state: TaskState.Done, pinned: true })
    task(300)
    done(400)
    updateTask(test.db, sampleTask(test.db, sampleWorkspace(test.db, '/code/other').id).id, { state: TaskState.Done })
    const other = listDoneTasks(test.db, { workspaceId: workspace.id, filter: TaskFilter.All, after: null, limit: 10 })

    expect(other.tasks).toHaveLength(2)
    expect(other.tasks.at(-1)?.id).toBe(listed.id)
  })

  it('narrows to the unread tasks under the Unread chip, and to none under Needs you', () => {
    const unread = [done(500, true), done(300, true), done(100, true)]
    done(400)
    done(200)

    expect(
      walk(TaskFilter.Unread, 2)
        .flat()
        .map(({ id }) => id),
    ).toEqual(ids(unread))
    expect(walk(TaskFilter.NeedsYou, 2)).toEqual([[]])
  })

  it('is unmoved by a task marked done at the top while paging: the next page starts where the last ended', () => {
    const tasks = [done(500), done(400), done(300), done(200)]
    const first = listDoneTasks(test.db, { workspaceId: workspace.id, filter: TaskFilter.All, after: null, limit: 2 })
    const joined = done(900)
    const last = first.tasks.at(-1)
    if (last === undefined) throw new Error('no first page')

    const second = listDoneTasks(test.db, {
      workspaceId: workspace.id,
      filter: TaskFilter.All,
      after: cursorOf(last),
      limit: 2,
    })

    expect(ids(second.tasks)).toEqual(ids(tasks.slice(2)))
    const top = listDoneTasks(test.db, { workspaceId: workspace.id, filter: TaskFilter.All, after: null, limit: 1 })
    expect(ids(top.tasks)).toEqual([joined.id])
  })

  it('pages through 1,200 done tasks, each once and in order, and agrees with the renderer’s stand-in', () => {
    const tasks = Array.from({ length: 1_200 }, (_, index) => done(100_000 - Math.floor(index / 3), index % 4 === 0))

    const pages = walk(TaskFilter.All, 100)

    expect(pages).toHaveLength(12)
    expect(pages.every((page) => page.length === 100)).toBe(true)
    const listed = pages.flat()
    expect(new Set(ids(listed)).size).toBe(1_200)
    expect(ids(listed)).toEqual(
      ids(pageOfDone(tasks, { workspaceId: workspace.id, filter: TaskFilter.All, after: null, limit: 1_200 }).tasks),
    )
    expect(walk(TaskFilter.Unread, 100).flat()).toHaveLength(300)
  })

  it('reads each page with the Done section’s index, not a scan of the tasks', () => {
    const plan = test.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM tasks WHERE workspace_id = 'w' AND state = 'done' AND pinned = 0
          AND updated_at <= 5 AND (updated_at < 5 OR id > 'x') ORDER BY updated_at DESC, id LIMIT 101`,
      )
      .all()
      .map((row) => JSON.stringify(row))
      .join('\n')

    expect(plan).toContain('USING INDEX tasks_done_list')
    // The index gives the order too: no sorting in a temporary tree.
    expect(plan).not.toContain('TEMP B-TREE')
  })
})

describe('getTasks', () => {
  it('answers the tasks that exist among the ids', () => {
    const first = done(100)
    const second = task(200)

    expect(ids(getTasks(test.db, [second.id, 'gone', first.id])).sort()).toEqual([first.id, second.id].sort())
    expect(getTasks(test.db, [])).toEqual([])
  })
})
