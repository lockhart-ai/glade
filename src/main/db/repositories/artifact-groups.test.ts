import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArtifactDateGroup } from '../../../shared/domain'
import { listArtifactGroups, setArtifactGroupOpen } from './artifact-groups'
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

describe('artifact date groups', () => {
  it('are none until one is opened or folded', () => {
    expect(listArtifactGroups(database.db, taskId)).toEqual([])
  })

  it('remember each group, newest group first, the last change winning, for their own task only', () => {
    const { db } = database
    setArtifactGroupOpen(db, { taskId, group: ArtifactDateGroup.Older, open: true })
    setArtifactGroupOpen(db, { taskId, group: ArtifactDateGroup.Today, open: false })
    setArtifactGroupOpen(db, { taskId, group: ArtifactDateGroup.LastWeek, open: true })
    setArtifactGroupOpen(db, { taskId, group: ArtifactDateGroup.LastWeek, open: false })
    setArtifactGroupOpen(db, { taskId: otherId, group: ArtifactDateGroup.ThisMonth, open: true })

    expect(listArtifactGroups(db, taskId)).toEqual([
      { group: ArtifactDateGroup.Today, open: false },
      { group: ArtifactDateGroup.LastWeek, open: false },
      { group: ArtifactDateGroup.Older, open: true },
    ])
    expect(listArtifactGroups(db, otherId)).toEqual([{ group: ArtifactDateGroup.ThisMonth, open: true }])
  })

  it('go with their task', () => {
    setArtifactGroupOpen(database.db, { taskId, group: ArtifactDateGroup.Yesterday, open: false })

    deleteTask(database.db, taskId)

    expect(listArtifactGroups(database.db, taskId)).toEqual([])
  })

  it('refuse a group the tab doesn’t have, and a row that says one', () => {
    const { db } = database
    expect(() => {
      setArtifactGroupOpen(db, { taskId, group: 'someday' as ArtifactDateGroup, open: true })
    }).toThrow(/CHECK/)
    // A row written past the CHECK (as a later version might) fails to parse, naming the column.
    db.pragma('ignore_check_constraints = ON')
    db.prepare("INSERT INTO artifact_groups VALUES (?, 'someday', 1)").run(taskId)
    expect(() => listArtifactGroups(db, taskId)).toThrow(/artifact_groups\.date_group/)
  })
})
