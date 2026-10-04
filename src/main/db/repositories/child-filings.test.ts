import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChildKind, FilingSource, type ChildRef, type NewFiling } from '../../../shared/todoHub'
import { listFilings, putFilings, removeFilings } from './child-filings'
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
const REVIEWER: ChildRef = { kind: ChildKind.Subagent, key: 'toolu_agent' }
const CI: ChildRef = { kind: ChildKind.Watcher, key: 'toolu_monitor' }
const FIX: ChildRef = { kind: ChildKind.Commit, key: 'abc123 /code/acme-api' }

function under(todoId: string, source: FilingSource, ...children: ChildRef[]): NewFiling[] {
  return children.map((child) => ({ ...child, todoId, source }))
}

describe('a task’s filings', () => {
  it('are none until something is filed', () => {
    expect(listFilings(database.db, taskId)).toEqual([])
  })

  it('keep a child of each kind under its todo, with how and when it was filed, for their own task only', () => {
    const { db } = database

    const filed = putFilings(db, taskId, under('2', FilingSource.Named, PLAN, PR, REVIEWER), 5_000)
    putFilings(db, taskId, under('3', FilingSource.Inherited, CI, FIX), 6_000)
    putFilings(db, otherId, under('1', FilingSource.Moved, PLAN), 7_000)

    expect(filed).toEqual([
      { taskId, ...PLAN, todoId: '2', source: FilingSource.Named, filedAt: 5_000 },
      { taskId, ...PR, todoId: '2', source: FilingSource.Named, filedAt: 5_000 },
      { taskId, ...REVIEWER, todoId: '2', source: FilingSource.Named, filedAt: 5_000 },
    ])
    // Oldest first, and within one moment by kind and key.
    expect(listFilings(db, taskId)).toEqual([
      ...filed,
      { taskId, ...FIX, todoId: '3', source: FilingSource.Inherited, filedAt: 6_000 },
      { taskId, ...CI, todoId: '3', source: FilingSource.Inherited, filedAt: 6_000 },
    ])
    expect(listFilings(db, otherId)).toEqual([
      { taskId: otherId, ...PLAN, todoId: '1', source: FilingSource.Moved, filedAt: 7_000 },
    ])
  })

  it('keep one filing per child: filing it again replaces the last, todo, source and time', () => {
    const { db } = database
    putFilings(db, taskId, under('1', FilingSource.Named, PLAN, PR), 5_000)

    const moved = putFilings(db, taskId, under('4', FilingSource.Moved, PLAN), 8_000)

    expect(moved).toEqual([{ taskId, ...PLAN, todoId: '4', source: FilingSource.Moved, filedAt: 8_000 }])
    expect(listFilings(db, taskId)).toEqual([
      { taskId, ...PR, todoId: '1', source: FilingSource.Named, filedAt: 5_000 },
      { taskId, ...PLAN, todoId: '4', source: FilingSource.Moved, filedAt: 8_000 },
    ])
    // The same child twice in one call: the later one counts, and there is still one row.
    putFilings(db, taskId, [...under('5', FilingSource.Moved, PR), ...under('6', FilingSource.Moved, PR)], 9_000)
    expect(listFilings(db, taskId).filter(({ key }) => key === PR.key)).toEqual([
      { taskId, ...PR, todoId: '6', source: FilingSource.Moved, filedAt: 9_000 },
    ])
  })

  it('tell apart two children with one key and different kinds', () => {
    const { db } = database
    const call = 'toolu_1'
    putFilings(db, taskId, [
      { kind: ChildKind.Subagent, key: call, todoId: '1', source: FilingSource.Named },
      { kind: ChildKind.Watcher, key: call, todoId: '2', source: FilingSource.Named },
    ])

    expect(listFilings(db, taskId).map(({ kind, todoId }) => [kind, todoId])).toEqual([
      [ChildKind.Subagent, '1'],
      [ChildKind.Watcher, '2'],
    ])
  })

  it('file all of a call’s children or none of them', () => {
    const { db } = database
    putFilings(db, taskId, under('1', FilingSource.Named, PLAN), 5_000)

    expect(() =>
      putFilings(
        db,
        taskId,
        [
          ...under('2', FilingSource.Moved, PLAN, PR),
          { kind: ChildKind.File, key: '', todoId: '2', source: FilingSource.Moved },
        ],
        6_000,
      ),
    ).toThrow(/CHECK/)
    expect(() => putFilings(db, 'gone', under('2', FilingSource.Named, PR))).toThrow(/FOREIGN KEY/)

    expect(listFilings(db, taskId)).toEqual([
      { taskId, ...PLAN, todoId: '1', source: FilingSource.Named, filedAt: 5_000 },
    ])
  })

  it('file 200 children in one call', () => {
    const { db } = database
    const children = Array.from({ length: 200 }, (_, index) => ({
      kind: ChildKind.File,
      key: `docs/file-${String(index).padStart(3, '0')}.md`,
    }))

    expect(putFilings(db, taskId, under('1', FilingSource.Moved, ...children), 5_000)).toHaveLength(200)
    expect(listFilings(db, taskId).map(({ key }) => key)).toEqual(children.map(({ key }) => key))
  })

  it('lose the ones taken away, answering with the children that had one', () => {
    const { db } = database
    putFilings(db, taskId, under('1', FilingSource.Named, PLAN, PR, CI), 5_000)
    putFilings(db, otherId, under('1', FilingSource.Named, PLAN), 5_000)

    // The plan twice, and a child that was never filed.
    expect(removeFilings(db, taskId, [PLAN, FIX, PLAN, CI])).toEqual([PLAN, CI])

    expect(listFilings(db, taskId).map(({ key }) => key)).toEqual([PR.key])
    expect(listFilings(db, otherId)).toHaveLength(1)
    expect(removeFilings(db, taskId, [])).toEqual([])
    expect(removeFilings(db, 'gone', [PR])).toEqual([])
  })

  it('go with their task', () => {
    const { db } = database
    putFilings(db, taskId, under('1', FilingSource.Named, PLAN))
    putFilings(db, otherId, under('1', FilingSource.Named, PLAN))

    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)

    expect(listFilings(db, taskId)).toEqual([])
    expect(listFilings(db, otherId)).toHaveLength(1)
  })

  it('are dated now unless told otherwise', () => {
    const before = Date.now()
    const [filing] = putFilings(database.db, taskId, under('1', FilingSource.Named, PLAN))
    expect(filing?.filedAt).toBeGreaterThanOrEqual(before)
  })

  it('fail to read a row the schema could never hold', () => {
    const { db } = database
    putFilings(db, taskId, under('1', FilingSource.Named, PLAN))
    db.pragma('ignore_check_constraints = ON')
    db.prepare("UPDATE child_filings SET source = 'guessed'").run()

    expect(() => listFilings(db, taskId)).toThrow(RowError)
  })
})
