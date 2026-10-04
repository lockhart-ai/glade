import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChildFilter, UNFILED_TODO_ID } from '../../../shared/todoHub'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'
import { listTodoPanels, setTodoPanel } from './todo-panels'

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

describe('the panels of a task’s todos', () => {
  it('are none until one is changed', () => {
    expect(listTodoPanels(database.db, taskId)).toEqual([])
  })

  it('remember each todo’s own, open or closed and with its filter, for their own task only', () => {
    const { db } = database
    setTodoPanel(db, { taskId, todoId: '2', open: true, filter: ChildFilter.All })
    setTodoPanel(db, { taskId, todoId: '1', open: true, filter: ChildFilter.Watchers })
    // Closed again, a panel keeps its filter.
    setTodoPanel(db, { taskId, todoId: '3', open: false, filter: ChildFilter.Commits })
    setTodoPanel(db, { taskId: otherId, todoId: '1', open: true, filter: ChildFilter.Files })

    expect(listTodoPanels(db, taskId)).toEqual([
      { taskId, todoId: '1', open: true, filter: ChildFilter.Watchers },
      { taskId, todoId: '2', open: true, filter: ChildFilter.All },
      { taskId, todoId: '3', open: false, filter: ChildFilter.Commits },
    ])
    expect(listTodoPanels(db, otherId)).toEqual([
      { taskId: otherId, todoId: '1', open: true, filter: ChildFilter.Files },
    ])
  })

  it('keep one row per todo: changing it again replaces what it had', () => {
    const { db } = database
    setTodoPanel(db, { taskId, todoId: '1', open: true, filter: ChildFilter.Files })
    setTodoPanel(db, { taskId, todoId: '1', open: true, filter: ChildFilter.Subagents })
    setTodoPanel(db, { taskId, todoId: '1', open: false, filter: ChildFilter.Subagents })

    expect(listTodoPanels(db, taskId)).toEqual([{ taskId, todoId: '1', open: false, filter: ChildFilter.Subagents }])
  })

  it('forget one that’s back to how every panel starts: closed, showing all', () => {
    const { db } = database
    setTodoPanel(db, { taskId, todoId: '1', open: true, filter: ChildFilter.Links })
    setTodoPanel(db, { taskId, todoId: '2', open: true, filter: ChildFilter.All })

    setTodoPanel(db, { taskId, todoId: '1', open: false, filter: ChildFilter.All })
    // One that was never changed has nothing to forget.
    setTodoPanel(db, { taskId, todoId: '9', open: false, filter: ChildFilter.All })

    expect(listTodoPanels(db, taskId)).toEqual([{ taskId, todoId: '2', open: true, filter: ChildFilter.All }])
    expect(db.prepare('SELECT COUNT(*) FROM todo_panels').pluck().get()).toBe(1)
  })

  it('keep the placeholder group’s under its reserved id', () => {
    const { db } = database
    setTodoPanel(db, { taskId, todoId: UNFILED_TODO_ID, open: true, filter: ChildFilter.Files })

    expect(listTodoPanels(db, taskId)).toEqual([
      { taskId, todoId: UNFILED_TODO_ID, open: true, filter: ChildFilter.Files },
    ])
  })

  it('go with their task, and can’t be kept for a task that isn’t there', () => {
    const { db } = database
    setTodoPanel(db, { taskId, todoId: '1', open: true, filter: ChildFilter.All })
    setTodoPanel(db, { taskId: otherId, todoId: '1', open: true, filter: ChildFilter.All })

    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)

    expect(listTodoPanels(db, taskId)).toEqual([])
    expect(listTodoPanels(db, otherId)).toHaveLength(1)
    expect(() => {
      setTodoPanel(db, { taskId: 'gone', todoId: '1', open: true, filter: ChildFilter.All })
    }).toThrow(/FOREIGN KEY/)
  })
})
