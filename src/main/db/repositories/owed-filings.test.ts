import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChildKind, type ChildRef } from '../../../shared/todoHub'
import { WATCHER_KIND } from './child-ids'
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
const NOTE: ChildRef = { kind: ChildKind.Commit, key: 'toolu_1' }
const FIX: ChildRef = { kind: ChildKind.Commit, key: 'abc123 /code/acme-api' }

describe('the filings a task’s agent owes', () => {
  it('are none until some are recorded, then listed in the order they were, per task', () => {
    const { db } = database
    expect(listOwedFilings(db, taskId)).toEqual([])

    oweFilings(db, taskId, [REVIEWER, NOTE], 2_000)
    oweFilings(db, taskId, [FIX], 1_000)
    oweFilings(db, otherId, [NOTE], 3_000)

    // By when each was made, then as given: a subagent and a commit with the same key are two.
    expect(listOwedFilings(db, taskId)).toEqual([FIX, REVIEWER, NOTE])
    expect(listOwedFilings(db, otherId)).toEqual([NOTE])
  })

  it('keep a child recorded twice once, as it was first', () => {
    const { db } = database
    oweFilings(db, taskId, [REVIEWER], 1_000)
    oweFilings(db, taskId, [NOTE, REVIEWER], 5_000)

    expect(listOwedFilings(db, taskId)).toEqual([REVIEWER, NOTE])
    expect(db.prepare("SELECT made_at FROM owed_filings WHERE kind = 'subagent'").pluck().get()).toBe(1_000)
  })

  it('are settled one by one, and one that was never owed changes nothing', () => {
    const { db } = database
    oweFilings(db, taskId, [REVIEWER, NOTE, FIX], 1_000)
    oweFilings(db, otherId, [NOTE], 1_000)

    settleOwedFilings(db, taskId, [NOTE, { kind: ChildKind.Link, key: 'https://example.com/pr/511' }])

    expect(listOwedFilings(db, taskId)).toEqual([REVIEWER, FIX])
    expect(listOwedFilings(db, otherId)).toEqual([NOTE])
    settleOwedFilings(db, taskId, [])
    oweFilings(db, taskId, [])
    expect(listOwedFilings(db, taskId)).toEqual([REVIEWER, FIX])
  })

  it('go with their task', () => {
    const { db } = database
    oweFilings(db, taskId, [REVIEWER], 1_000)
    oweFilings(db, otherId, [NOTE], 1_000)

    deleteTask(db, taskId)

    expect(db.prepare('SELECT COUNT(*) FROM owed_filings').pluck().get()).toBe(1)
    expect(listOwedFilings(db, otherId)).toEqual([NOTE])
  })

  it('leave out a watcher, from when one could be owed a filing (before #535): it’s owed nothing', () => {
    const { db } = database
    // As the hub wrote one then: the table's check still allows the kind.
    db.prepare('INSERT INTO owed_filings (task_id, kind, key, made_at) VALUES (?, ?, ?, ?)').run(
      taskId,
      WATCHER_KIND,
      REVIEWER.key,
      500,
    )
    oweFilings(db, taskId, [REVIEWER, FIX], 1_000)

    expect(listOwedFilings(db, taskId)).toEqual([REVIEWER, FIX])
    settleOwedFilings(db, taskId, [REVIEWER])
    expect(listOwedFilings(db, taskId)).toEqual([FIX])
    expect(db.prepare('SELECT COUNT(*) FROM owed_filings WHERE kind = ?').pluck().get(WATCHER_KIND)).toBe(1)
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
