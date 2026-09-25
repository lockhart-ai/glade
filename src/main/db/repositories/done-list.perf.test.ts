// The Done section has to stay quick however long it grows: each page is a short range of an index, so the last page of
// thousands of done tasks costs what the first does.
import { afterAll, beforeAll, expect, it } from 'vitest'
import { TaskFilter } from '../../../shared/attention'
import { cursorOf, DONE_PAGE_SIZE, type TaskCursor } from '../../../shared/doneList'
import { Effort, TaskState } from '../../../shared/domain'
import { countDoneTasks, createTask, listActiveTasks, listDoneTasks, updateTask } from './tasks'
import { openTestDatabase, sampleWorkspace, type TestDatabase } from './test-database'

const DONE_TASKS = 2_000
const ACTIVE_TASKS = 20
/** What loading one page, or the counts, may take: far less than a frame. */
const BUDGET_MS = 20

let database: TestDatabase
let workspaceId: string

beforeAll(() => {
  database = openTestDatabase()
  const { db } = database
  workspaceId = sampleWorkspace(db).id
  db.transaction(() => {
    for (let index = 0; index < DONE_TASKS + ACTIVE_TASKS; index += 1) {
      const task = createTask(
        db,
        { workspaceId, model: 'claude-sample-1', effort: Effort.Medium, title: `Task ${String(index)}` },
        1_000,
      )
      const done = index >= ACTIVE_TASKS
      updateTask(
        db,
        task.id,
        { state: done ? TaskState.Done : TaskState.Active, unread: index % 5 === 0 },
        1_000 + index,
      )
    }
  })()
})

afterAll(() => {
  database.close()
})

/** The CPU time this process has used, in milliseconds (see search.perf.test.ts for why not the wall clock). */
function cpuMs(): number {
  const { user, system } = process.cpuUsage()
  return (user + system) / 1000
}

/** How long `run` takes: the median of a few runs after a warm-up, in milliseconds of CPU time. */
function timed(run: () => void): number {
  run()
  const times: number[] = []
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const start = cpuMs()
    run()
    times.push(cpuMs() - start)
  }
  times.sort((a, b) => a - b)
  return times[3] ?? Infinity
}

it(`loads what the window loads whole, and the counts, within ${String(BUDGET_MS)}ms with ${String(DONE_TASKS)} done tasks`, () => {
  expect(timed(() => listActiveTasks(database.db, workspaceId))).toBeLessThan(BUDGET_MS)
  expect(timed(() => countDoneTasks(database.db, workspaceId))).toBeLessThan(BUDGET_MS)
  expect(listActiveTasks(database.db, workspaceId)).toHaveLength(ACTIVE_TASKS)
  expect(countDoneTasks(database.db, workspaceId).all).toBe(DONE_TASKS)
})

it(`loads every page of ${String(DONE_TASKS)} done tasks within ${String(BUDGET_MS)}ms each, the last as quick as the first`, () => {
  let after: TaskCursor | null = null
  let loaded = 0
  const times: number[] = []
  for (;;) {
    const request = { workspaceId, filter: TaskFilter.All, after, limit: DONE_PAGE_SIZE }
    times.push(timed(() => listDoneTasks(database.db, request)))
    const page = listDoneTasks(database.db, request)
    loaded += page.tasks.length
    const last = page.tasks.at(-1)
    if (!page.hasMore || last === undefined) break
    after = cursorOf(last)
  }

  expect(loaded).toBe(DONE_TASKS)
  expect(Math.max(...times)).toBeLessThan(BUDGET_MS)
})
