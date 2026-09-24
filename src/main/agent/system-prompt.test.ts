import { beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '../../shared/domain'
import { openTestDatabase, sampleTask, sampleWorkspace } from '../db/repositories/test-database'
import { systemPromptAppend } from './system-prompt'

let task: Task

beforeEach(() => {
  const database = openTestDatabase()
  task = sampleTask(database.db, sampleWorkspace(database.db).id)
  database.close()
})

describe('systemPromptAppend', () => {
  it('names the task and, for a new one, asks for its title and objective and a status every turn', () => {
    expect(systemPromptAppend(task)).toBe(
      [
        'You are running inside Glade, a desktop app that runs Claude agent sessions as tasks.',
        'This session is one Glade task, with one objective.',
        `Its task id is ${task.id}. Its title is not set yet.`,
        '',
        'The user sees the task through its title, objective and status. Keep them current with the Glade tools:',
        "- After the user's first message, before anything else, even for a quick question, call set_title with a short name for the task " +
          'and set_objective with its objective.',
        '- Every turn, call set_status with one line on where the work stands, and again before you end the turn if ' +
          'that changed. When the task is done, the status is its outcome.',
        '',
        'When you need the user to decide something before you can go on, call ask instead of asking in your reply: ' +
          'it shows your questions on a card and waits for the answers. Ask everything you need at once, with ' +
          'choices or pills when the likely answers are known.',
      ].join('\n'),
    )
  })

  it('asks only for what is not set yet', () => {
    const titled = systemPromptAppend({ ...task, title: 'Fix the flaky login test' })
    expect(titled).toContain('Its title is "Fix the flaky login test".')
    expect(titled).toContain('call set_objective with its objective.')
    expect(titled).not.toContain('set_title')

    const described = systemPromptAppend({ ...task, objective: 'Make the login test pass every run.' })
    expect(described).toContain('call set_title with a short name for the task.')
    expect(described).not.toContain('set_objective')

    const both = systemPromptAppend({ ...task, title: 'Fix the flaky login test', objective: 'Make it pass.' })
    expect(both).not.toContain("the user's first message")
    expect(both).toContain('call set_status')
  })
})
