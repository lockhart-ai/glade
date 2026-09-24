import { describe, expect, it } from 'vitest'
import { ClaudeTodoStatus, createdTaskId, taskCreateInput, taskUpdateInput, todoWriteInput } from './schema'

describe('todoWriteInput', () => {
  it("parses TodoWrite's list, keeping the fields Glade reads", () => {
    const input = {
      todos: [
        { content: 'Find the uploads', status: 'completed', activeForm: 'Finding the uploads' },
        { content: 'Copy the files', status: 'in_progress', activeForm: 'Copying the files', priority: 'high' },
        { content: 'Delete local copies', status: 'pending' },
      ],
    }
    expect(todoWriteInput.parse(input)).toEqual({
      todos: [
        { content: 'Find the uploads', status: ClaudeTodoStatus.Completed, activeForm: 'Finding the uploads' },
        { content: 'Copy the files', status: ClaudeTodoStatus.InProgress, activeForm: 'Copying the files' },
        { content: 'Delete local copies', status: ClaudeTodoStatus.Pending },
      ],
    })
  })

  it('refuses a status it does not know, or a list that is missing', () => {
    expect(todoWriteInput.safeParse({ todos: [{ content: 'Copy', status: 'blocked' }] }).success).toBe(false)
    expect(todoWriteInput.safeParse({}).success).toBe(false)
  })
})

describe('taskCreateInput', () => {
  it("parses TaskCreate's subject and active form", () => {
    expect(
      taskCreateInput.parse({ subject: 'Copy the files', description: 'All 3,900', activeForm: 'Copying the files' }),
    ).toEqual({ subject: 'Copy the files', activeForm: 'Copying the files' })
    expect(taskCreateInput.safeParse({ description: 'No subject' }).success).toBe(false)
  })
})

describe('taskUpdateInput', () => {
  it("parses TaskUpdate's changes, including deleting the task", () => {
    expect(taskUpdateInput.parse({ taskId: '2', status: 'in_progress', addBlocks: ['3'] })).toEqual({
      taskId: '2',
      status: ClaudeTodoStatus.InProgress,
    })
    expect(taskUpdateInput.parse({ taskId: '2', status: 'deleted' })).toEqual({ taskId: '2', status: 'deleted' })
    expect(taskUpdateInput.safeParse({ taskId: '2', status: 'archived' }).success).toBe(false)
    expect(taskUpdateInput.safeParse({ status: 'completed' }).success).toBe(false)
  })
})

describe('createdTaskId', () => {
  it("reads the new item's id from TaskCreate's result", () => {
    expect(createdTaskId('Task #12 created successfully: Copy the files')).toBe('12')
    expect(createdTaskId('Something else happened')).toBeUndefined()
  })
})
