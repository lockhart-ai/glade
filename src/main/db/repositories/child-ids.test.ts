import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChildKind, type ChildRef } from '../../../shared/todoHub'
import { assignChildIds, findChildById } from './child-ids'
import { RowError } from './rows'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'

let database: TestDatabase
let taskId: string
let otherId: string

beforeEach(() => {
  database = openTestDatabase()
  const workspaceId = sampleWorkspace(database.db).id
  taskId = sampleTask(database.db, workspaceId).id
  otherId = sampleTask(database.db, workspaceId).id
})

afterEach(() => {
  database.close()
})

const PLAN: ChildRef = { kind: ChildKind.File, key: 'docs/plan.md' }
const PR: ChildRef = { kind: ChildKind.Link, key: 'https://example.com/acme/api/pull/511' }
const REVIEWER: ChildRef = { kind: ChildKind.Subagent, key: 'toolu_1' }
const CI: ChildRef = { kind: ChildKind.Watcher, key: 'toolu_1' }
const FIX: ChildRef = { kind: ChildKind.Commit, key: 'abc123 /code/acme-api' }

describe('a child’s short id', () => {
  it('counts up from c1 within its task, in the order the children were first named', () => {
    const { db } = database

    expect(assignChildIds(db, taskId, [PLAN, PR])).toEqual([
      { ...PLAN, id: 'c1' },
      { ...PR, id: 'c2' },
    ])
    expect(assignChildIds(db, taskId, [REVIEWER])).toEqual([{ ...REVIEWER, id: 'c3' }])
    // Another task counts for itself, and the same file there is another child.
    expect(assignChildIds(db, otherId, [FIX, PLAN])).toEqual([
      { ...FIX, id: 'c1' },
      { ...PLAN, id: 'c2' },
    ])
    expect(assignChildIds(db, taskId, [FIX])).toEqual([{ ...FIX, id: 'c4' }])
  })

  it('never changes: a child named again has the id it had, among new ones or twice in one call', () => {
    const { db } = database
    assignChildIds(db, taskId, [PLAN, PR])

    expect(assignChildIds(db, taskId, [PR, CI, PLAN, CI, PR])).toEqual([
      { ...PR, id: 'c2' },
      { ...CI, id: 'c3' },
      { ...PLAN, id: 'c1' },
      { ...CI, id: 'c3' },
      { ...PR, id: 'c2' },
    ])
    expect(assignChildIds(db, taskId, [])).toEqual([])
    expect(db.prepare('SELECT COUNT(*) FROM child_ids WHERE task_id = ?').pluck().get(taskId)).toBe(3)
  })

  it('tells a subagent from a watcher started by a call with the same id', () => {
    expect(assignChildIds(database.db, taskId, [REVIEWER, CI])).toEqual([
      { ...REVIEWER, id: 'c1' },
      { ...CI, id: 'c2' },
    ])
  })

  it('is never given to another child, whatever is named after it, 300 children on', () => {
    const { db } = database
    const files = Array.from({ length: 300 }, (_, index) => ({ kind: ChildKind.File, key: `docs/${String(index)}.md` }))

    const ids = [...assignChildIds(db, taskId, files.slice(0, 120)), ...assignChildIds(db, taskId, files)].map(
      ({ id }) => id,
    )

    expect(ids.slice(0, 120)).toEqual(ids.slice(120, 240))
    expect(new Set(ids).size).toBe(300)
    expect(ids.at(-1)).toBe('c300')
    for (const [index, file] of files.entries()) {
      expect(findChildById(db, taskId, `c${String(index + 1)}`)).toEqual(file)
    }
  })

  it('names its child back, for its own task only', () => {
    const { db } = database
    assignChildIds(db, taskId, [PLAN, PR])
    assignChildIds(db, otherId, [FIX])

    expect(findChildById(db, taskId, 'c2')).toEqual(PR)
    expect(findChildById(db, otherId, 'c1')).toEqual(FIX)
    expect(findChildById(db, otherId, 'c2')).toBeUndefined()
    expect(findChildById(db, 'gone', 'c1')).toBeUndefined()
  })

  it('names nothing when it was never given, or isn’t an id at all', () => {
    const { db } = database
    assignChildIds(db, taskId, [PLAN])

    for (const id of ['c2', 'c0', 'c01', 'C1', '1', 'c', 'c1 ', 'c-1', 'c1.0', '', 'c99999999999999999999']) {
      expect(findChildById(db, taskId, id), id).toBeUndefined()
    }
  })

  it('can’t be kept for a task that isn’t there, or a child with no key, and then none of the call’s are', () => {
    const { db } = database

    expect(() => assignChildIds(db, 'gone', [PLAN])).toThrow(/FOREIGN KEY/)
    expect(() => assignChildIds(db, taskId, [PLAN, { kind: ChildKind.File, key: '' }])).toThrow(/CHECK/)

    expect(db.prepare('SELECT COUNT(*) FROM child_ids').pluck().get()).toBe(0)
    // The number that call would have used goes to the next child named.
    expect(assignChildIds(db, taskId, [PR])).toEqual([{ ...PR, id: 'c1' }])
  })

  it('goes with its task', () => {
    const { db } = database
    assignChildIds(db, taskId, [PLAN])
    assignChildIds(db, otherId, [PR])

    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)

    expect(findChildById(db, taskId, 'c1')).toBeUndefined()
    expect(findChildById(db, otherId, 'c1')).toEqual(PR)
  })

  it('fails to read a row the schema could never hold', () => {
    const { db } = database
    assignChildIds(db, taskId, [PLAN])
    db.pragma('ignore_check_constraints = ON')
    db.prepare("UPDATE child_ids SET kind = 'folder'").run()

    expect(() => findChildById(db, taskId, 'c1')).toThrow(RowError)
  })
})
