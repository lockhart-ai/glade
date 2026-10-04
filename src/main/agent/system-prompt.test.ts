import { beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '../../shared/domain'
import { openTestDatabase, sampleTask, sampleWorkspace } from '../db/repositories/test-database'
import {
  CONTROL_TOOLS_LINE,
  FINAL_REPLY_LINE,
  HANDOFF_HEADING,
  handoffSection,
  INSTRUCTION_UPDATES,
  LINK_ARTIFACTS_LINE,
  SANDBOX_LINE,
  systemPromptAppend,
  TODO_HUB_ARTIFACTS_LINE,
  TODO_HUB_FILING_LINE,
  TODO_HUB_LINES,
  TODO_HUB_TOOLS_LINE,
  WATCHERS_LINE,
} from './system-prompt'

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
        'In the chat, the user sees only your last message of each turn: what you write before a tool call goes to ' +
          'the tool log, which they rarely read. So end every turn with a complete reply that answers what they ' +
          'asked or responds to what they said, with any findings, even ones you wrote earlier in the turn. Do ' +
          'follow-up work (tool calls) before that reply, not after it.',
        '',
        'The user sees the task through its title, objective and status. Keep them current with the Glade tools:',
        "- After the user's first message, before anything else, even for a quick question, call set_title with a short name for the task " +
          'and set_objective with its objective.',
        '- Every turn, call set_status with one line on where the work stands, and again before you end the turn if ' +
          'that changed. When the task is done, the status is its outcome.',
        '',
        'When you need the user to decide something before you can go on, call ask instead of asking in your reply: ' +
          'it shows your questions on a card and waits for the answers. Ask everything you need at once, with ' +
          'choices or pills when the likely answers are known. When you ask in response to a message, first respond to ' +
          'it in preamble, then ask.',
        '',
        'When you make a deliverable the user asked for (a report, a document, a draft), call add_artifact with its ' +
          'path and a short title, so it shows in the Artifacts tab and stays with the task after it is done. Keep ' +
          "that list current: if its file moves or it needs a new title, call update_artifact; if it's no longer a " +
          'deliverable, call remove_artifact.',
        'When you open or work on a pull request, or the task is about an issue or a ticket (GitHub, Jira), call ' +
          'add_artifact with its url and a short title, so the user finds it in the Artifacts tab next to the files.',
        '',
        'When you leave a script running to watch something (a PR, CI, a deploy, a remote job), start it with the ' +
          "Monitor tool or with Bash's run_in_background, not by backgrounding it yourself (nohup, &), so it shows " +
          "in the task's Watchers tab.",
      ].join('\n'),
    )
    expect(systemPromptAppend(task)).toContain(WATCHERS_LINE)
  })

  it('tells every session that the user sees only its final reply each turn, whatever else it leaves out', () => {
    const variants = [
      systemPromptAppend(task),
      systemPromptAppend({ ...task, title: 'Fix the flaky login test', objective: 'Make it pass.' }),
      systemPromptAppend(task, { statusSummary: false, taskTitles: false }, true, {
        taskId: task.id,
        body: 'Notes: /code/acme-api/notes/',
        addedAt: 1_000,
      }),
    ]

    for (const prompt of variants) expect(prompt.split(FINAL_REPLY_LINE)).toHaveLength(2)
    expect(FINAL_REPLY_LINE).toContain('only your last message of each turn')
    expect(FINAL_REPLY_LINE).toContain('before that reply, not after it')
    // Sessions that started before it get it once, as an instruction added since (`./session-context`).
    expect(INSTRUCTION_UPDATES).toEqual([FINAL_REPLY_LINE, LINK_ARTIFACTS_LINE])
    for (const update of INSTRUCTION_UPDATES) expect(systemPromptAppend(task)).toContain(update)
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
    const body =
      '## Where it got to\n\n```sh\nnpm run replay -- --since 2026-03-01\n```\n\nNotes: /code/acme-api/notes/'
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

describe('the sandbox line', () => {
  it('tells a sandboxed session to ask with request_access when the sandbox blocks a command, not to leave it', () => {
    const prompt = systemPromptAppend(task, undefined, true, null, true)

    expect(prompt).toContain(SANDBOX_LINE)
    expect(SANDBOX_LINE).toContain('fails with "Operation not permitted" on a path outside the workspace')
    expect(SANDBOX_LINE).toContain("don't retry it outside the sandbox: call request_access with the absolute path")
    expect(SANDBOX_LINE).toContain('once it says the access is allowed, run the command again')
    // Ahead of the control tools' line, which stays last.
    expect(prompt.indexOf(SANDBOX_LINE)).toBeLessThan(prompt.indexOf(CONTROL_TOOLS_LINE))
  })

  it("doesn't mention the sandbox or request_access with it off", () => {
    for (const prompt of [systemPromptAppend(task), systemPromptAppend(task, undefined, true, null, false)]) {
      expect(prompt).not.toContain('sandbox')
      expect(prompt).not.toContain('request_access')
    }
  })
})

describe("the todo hub's lines", () => {
  const HUB_ON = { statusSummary: true, taskTitles: true, todoHubEnabled: true }

  it('tells a session with the hub on how what it makes is filed, and of its tools, after the watchers line', () => {
    const prompt = systemPromptAppend(task, HUB_ON)

    expect(prompt).toBe(
      `${systemPromptAppend(task)}\n\n${TODO_HUB_FILING_LINE}\n\n${TODO_HUB_ARTIFACTS_LINE}\n\n${TODO_HUB_TOOLS_LINE}`,
    )
    expect(TODO_HUB_LINES).toEqual([TODO_HUB_FILING_LINE, TODO_HUB_ARTIFACTS_LINE, TODO_HUB_TOOLS_LINE])
    for (const line of TODO_HUB_LINES) expect(line).not.toContain('\n')
    expect(TODO_HUB_TOOLS_LINE).toContain("list_children lists them, each with a short id and the todo it's under")
    expect(TODO_HUB_TOOLS_LINE).toContain('file_children files them under a todo or moves them to another')
    // Ahead of the sandbox's and the control tools' lines and the handoff note, which stay last.
    const all = systemPromptAppend(task, HUB_ON, true, { taskId: task.id, body: 'Notes.', addedAt: 1_000 }, true)
    const places = [
      WATCHERS_LINE,
      TODO_HUB_FILING_LINE,
      TODO_HUB_ARTIFACTS_LINE,
      TODO_HUB_TOOLS_LINE,
      SANDBOX_LINE,
      CONTROL_TOOLS_LINE,
      HANDOFF_HEADING,
    ].map((line) => all.indexOf(line))
    expect(places).toEqual([...places].sort((a, b) => a - b))
    expect(places[0]).toBeGreaterThan(0)
  })

  it('says to name the todo in the call that makes a child, in the words the probes ran with', () => {
    // docs/sdk-notes.md §16, "The prompt lines": Opus and Sonnet named a todo in every call with this paragraph.
    expect(TODO_HUB_FILING_LINE).toBe(
      'Glade files everything you make (a subagent, a watcher or background command, a scheduled wakeup or cron job, a ' +
        'commit) under one of your todos, where the user finds it. Name the todo in the call that makes it: start the ' +
        'description of an Agent, Monitor or background Bash call, the description of a Bash call that commits, the ' +
        "reason of a ScheduleWakeup and the prompt of a CronCreate with the todo's id in square brackets, like " +
        '"[todo 2] Review the date helpers". Create the todo first (TaskCreate) if none fits. If a call names none, ' +
        'Glade asks you right after it to file what it made, with mcp__glade__file_children: do that at once, before ' +
        'your next step. What a subagent makes is filed with the subagent: leave those.',
    )
    expect(TODO_HUB_ARTIFACTS_LINE).toBe(
      "An artifact goes under a todo too: give add_artifact the todo's id as todo, for a file and for a link.",
    )
  })

  it("says nothing of the hub or its tools with the switch off, as it's off unless given", () => {
    const off = [
      systemPromptAppend(task),
      systemPromptAppend(task, { statusSummary: true, taskTitles: true }),
      systemPromptAppend(task, { statusSummary: true, taskTitles: true, todoHubEnabled: false }),
      systemPromptAppend(
        task,
        { statusSummary: false, taskTitles: false, todoHubEnabled: undefined },
        true,
        null,
        true,
      ),
    ]

    for (const prompt of off) {
      expect(prompt).not.toContain('list_children')
      expect(prompt).not.toContain('file_children')
      expect(prompt).not.toMatch(/\[todo \d+\]|under one of your todos|as todo/)
      for (const line of TODO_HUB_LINES) expect(prompt).not.toContain(line)
    }
    // They're for sessions with the hub alone, so none is among the instructions every resumed session is sent: a
    // session's count of those stays what it was, hub or no hub.
    for (const line of TODO_HUB_LINES) expect(INSTRUCTION_UPDATES).not.toContain(line)
    expect(INSTRUCTION_UPDATES).toEqual([FINAL_REPLY_LINE, LINK_ARTIFACTS_LINE])
  })
})
