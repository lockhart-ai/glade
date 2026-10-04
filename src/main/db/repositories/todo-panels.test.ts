import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChildFilter, UNFILED_TODO_ID } from '../../../shared/todoHub'
import { RowError } from './rows'
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
    setTodoPanel(db, { taskId, todoId: '1', open: true, filter: ChildFilter.Links })
    // Closed again, a panel keeps its filter.
    setTodoPanel(db, { taskId, todoId: '3', open: false, filter: ChildFilter.Commits })
    setTodoPanel(db, { taskId: otherId, todoId: '1', open: true, filter: ChildFilter.Files })

    expect(listTodoPanels(db, taskId)).toEqual([
      { taskId, todoId: '1', open: true, filter: ChildFilter.Links },
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
    setTodoPanel(db, { taskId, todoId: '1', open: true, filter: ChildFilter.Commits })
    setTodoPanel(db, { taskId, todoId: '1', open: false, filter: ChildFilter.Commits })

    expect(listTodoPanels(db, taskId)).toEqual([{ taskId, todoId: '1', open: false, filter: ChildFilter.Commits }])
  })

  describe('left on a filter that’s gone (Subagents or Watchers, before #535)', () => {
    /** A panel's row as the hub wrote one then: the table's check still allows both. */
    function left(todoId: string, open: boolean, filter: string): void {
      database.db
        .prepare('INSERT INTO todo_panels (task_id, todo_id, open, filter) VALUES (?, ?, ?, ?)')
        .run(taskId, todoId, open ? 1 : 0, filter)
    }
    const stored = (): unknown[] =>
      database.db.prepare('SELECT todo_id, filter FROM todo_panels ORDER BY todo_id').raw().all()

    it('read as showing all, open or closed as they were, with no error, and their rows stay as they are', () => {
      left('1', true, 'subagent')
      left('2', false, 'watcher')
      left('3', true, 'watcher')
      setTodoPanel(database.db, { taskId, todoId: '4', open: true, filter: ChildFilter.Links })

      expect(listTodoPanels(database.db, taskId)).toEqual([
        { taskId, todoId: '1', open: true, filter: ChildFilter.All },
        { taskId, todoId: '2', open: false, filter: ChildFilter.All },
        { taskId, todoId: '3', open: true, filter: ChildFilter.All },
        { taskId, todoId: '4', open: true, filter: ChildFilter.Links },
      ])
      // Read past, not cleaned up.
      expect(stored()).toEqual([
        ['1', 'subagent'],
        ['2', 'watcher'],
        ['3', 'watcher'],
        ['4', 'link'],
      ])
    })

    it('are rewritten, or forgotten, the next time their panel is opened, closed or filtered', () => {
      left('1', true, 'subagent')
      left('2', true, 'watcher')

      setTodoPanel(database.db, { taskId, todoId: '1', open: true, filter: ChildFilter.Files })
      // Closed, as it reads: closed and showing all, which is how every panel starts.
      setTodoPanel(database.db, { taskId, todoId: '2', open: false, filter: ChildFilter.All })

      expect(stored()).toEqual([['1', 'file']])
      expect(listTodoPanels(database.db, taskId)).toEqual([
        { taskId, todoId: '1', open: true, filter: ChildFilter.Files },
      ])
    })

    it('still fail to read a filter that never was one', () => {
      database.db.pragma('ignore_check_constraints = ON')
      left('1', true, 'folder')

      expect(() => listTodoPanels(database.db, taskId)).toThrow(RowError)
    })
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
