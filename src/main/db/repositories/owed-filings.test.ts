import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChildKind, type ChildRef } from '../../../shared/todoHub'
import { listOwedFilings, oweFilings, settleOwedFilings } from './owed-filings'
import { RowError } from './rows'
import { deleteTask } from './tasks'
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

const REVIEWER: ChildRef = { kind: ChildKind.Subagent, key: 'toolu_1' }
const CI: ChildRef = { kind: ChildKind.Watcher, key: 'toolu_1' }
const FIX: ChildRef = { kind: ChildKind.Commit, key: 'abc123 /code/acme-api' }

describe('the filings a task’s agent owes', () => {
  it('are none until some are recorded, then listed in the order they were, per task', () => {
    const { db } = database
    expect(listOwedFilings(db, taskId)).toEqual([])

    oweFilings(db, taskId, [REVIEWER, CI], 2_000)
    oweFilings(db, taskId, [FIX], 1_000)
    oweFilings(db, otherId, [CI], 3_000)

    // By when each was made, then as given: a subagent and a watcher started by calls with the same id are two.
    expect(listOwedFilings(db, taskId)).toEqual([FIX, REVIEWER, CI])
    expect(listOwedFilings(db, otherId)).toEqual([CI])
  })

  it('keep a child recorded twice once, as it was first', () => {
    const { db } = database
    oweFilings(db, taskId, [REVIEWER], 1_000)
    oweFilings(db, taskId, [CI, REVIEWER], 5_000)

    expect(listOwedFilings(db, taskId)).toEqual([REVIEWER, CI])
    expect(db.prepare("SELECT made_at FROM owed_filings WHERE kind = 'subagent'").pluck().get()).toBe(1_000)
  })

  it('are settled one by one, and one that was never owed changes nothing', () => {
    const { db } = database
    oweFilings(db, taskId, [REVIEWER, CI, FIX], 1_000)
    oweFilings(db, otherId, [CI], 1_000)

    settleOwedFilings(db, taskId, [CI, { kind: ChildKind.Link, key: 'https://example.com/pr/511' }])

    expect(listOwedFilings(db, taskId)).toEqual([REVIEWER, FIX])
    expect(listOwedFilings(db, otherId)).toEqual([CI])
    settleOwedFilings(db, taskId, [])
    oweFilings(db, taskId, [])
    expect(listOwedFilings(db, taskId)).toEqual([REVIEWER, FIX])
  })

  it('go with their task', () => {
    const { db } = database
    oweFilings(db, taskId, [REVIEWER], 1_000)
    oweFilings(db, otherId, [CI], 1_000)

    deleteTask(db, taskId)

    expect(db.prepare('SELECT COUNT(*) FROM owed_filings').pluck().get()).toBe(1)
    expect(listOwedFilings(db, otherId)).toEqual([CI])
  })

  it('refuse a kind that is none, and a child with no key', () => {
    const { db } = database
    const insert = db.prepare('INSERT INTO owed_filings (task_id, kind, key, made_at) VALUES (?, ?, ?, 1)')

    expect(() => insert.run(taskId, 'todo', 'x')).toThrow(/CHECK/)
    expect(() => insert.run(taskId, 'watcher', '')).toThrow(/CHECK/)
    expect(() => insert.run('no-such-task', 'watcher', 'toolu_1')).toThrow(/FOREIGN KEY/)
    // A row that isn't a child's (written around the check) is refused when read.
    db.pragma('ignore_check_constraints = ON')
    insert.run(taskId, 'todo', 'x')
    expect(() => listOwedFilings(db, taskId)).toThrow(RowError)
  })
})
