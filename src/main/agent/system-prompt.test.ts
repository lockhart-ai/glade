import { beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '../../shared/domain'
import { openTestDatabase, sampleTask, sampleWorkspace } from '../db/repositories/test-database'
import { CONTROL_TOOLS_LINE, HANDOFF_HEADING, handoffSection, systemPromptAppend } from './system-prompt'

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
        '',
        'When you make a deliverable the user asked for (a report, a document, a draft), call add_artifact with its ' +
          'path and a short title, so it shows in the Artifacts tab and stays with the task after it is done.',
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

  it('leaves out the title and the status when Settings has them off', () => {
    const untitled = systemPromptAppend(task, { statusSummary: true, taskTitles: false })
    expect(untitled).toContain('call set_objective with its objective.')
    expect(untitled).not.toContain('set_title')
    expect(untitled).toContain('call set_status')

    const quiet = systemPromptAppend(task, { statusSummary: false, taskTitles: true })
    expect(quiet).toContain('call set_title with a short name for the task and set_objective with its objective.')
    expect(quiet).not.toContain('set_status')
    expect(quiet).toContain('call ask instead')
  })

  it("says in one line, at the end, that the session has Glade's control tools, when it has them", () => {
    const controlling = systemPromptAppend(task, undefined, true)

    expect(controlling).toBe(`${systemPromptAppend(task)}\n\n${CONTROL_TOOLS_LINE}`)
    expect(CONTROL_TOOLS_LINE).toContain('glade-control')
    expect(CONTROL_TOOLS_LINE).toContain('only when the user asks')
    expect(systemPromptAppend(task)).not.toContain('glade-control')
  })

  it("ends with the task's handoff note under its heading, saying its paths are real, when it has one", () => {
    const body = '## Where it got to\n\n```sh\nnpm run replay -- --since 2026-03-01\n```\n\nNotes: /code/acme-api/notes/'
    const handoff = { taskId: task.id, body, addedAt: 1_000 }

    const prompt = systemPromptAppend(task, undefined, true, handoff)

    expect(prompt).toBe(`${systemPromptAppend(task, undefined, true)}\n\n${handoffSection(handoff)}`)
    expect(handoffSection(handoff)).toBe(
      [
        `## ${HANDOFF_HEADING}`,
        '',
        'This task was worked on before it was in Glade. This note says what it was, where it got to, the decisions ' +
          "made, what's next, and where its notes, artifacts and history are. Pick up from here. The paths it names " +
          'are real: read them when you need more than the note says.',
        '',
        body,
      ].join('\n'),
    )
    expect(systemPromptAppend(task)).not.toContain(HANDOFF_HEADING)
  })
})
