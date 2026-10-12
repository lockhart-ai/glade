import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import { addArtifact, addLinkArtifact } from '../db/repositories/artifacts'
import { TaskActivity, TaskState, type Task } from '../../shared/domain'
import { updateTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { createWorkspace } from '../db/repositories/workspaces'
import { TaskAttention } from '../../shared/attention'
import {
  OTHER_TASKS_LINKS_MAX,
  OTHER_TASKS_LINK_TEXT_MAX,
  OTHER_TASKS_MAX,
  OTHER_TASKS_TEXT_MAX,
  otherTasksAnswer,
  otherTasksText,
} from './other-tasks'

let database: TestDatabase
let db: Database

beforeEach(() => {
  database = openTestDatabase()
  db = database.db
})

afterEach(() => {
  database.close()
})

describe('otherTasksAnswer', () => {
  it('lists the Active tasks across every workspace, most recently updated first, the caller marked as itself', () => {
    const acme = sampleWorkspace(db, '/code/acme-api')
    const widgets = createWorkspace(db, { name: 'Widgets', rootPath: '/code/widgets' }, 1_000)
    const older = sampleTask(db, acme.id, 1_000)
    const newer = sampleTask(db, widgets.id, 1_000)
    updateTask(db, newer.id, { title: 'Newer task', updatedAt: 3_000 })
    const done = sampleTask(db, acme.id, 1_000)
    updateTask(db, done.id, { title: 'Finished', state: TaskState.Done, updatedAt: 4_000 })
    updateTask(db, older.id, { title: 'Older task', updatedAt: 2_000 })

    const answer = otherTasksAnswer(db, older.id)

    expect(answer.cut).toBe(false)
    expect(answer.tasks.map((task) => task.id)).toEqual([newer.id, older.id])
    expect(answer.tasks.map((task) => task.workspace)).toEqual(['Widgets', 'Acme API'])
    expect(answer.tasks.find((task) => task.id === older.id)).toMatchObject({ isSelf: true, title: 'Older task' })
    expect(answer.tasks.find((task) => task.id === newer.id)).toMatchObject({ isSelf: false, title: 'Newer task' })
    // The done task is never listed, whatever its own updatedAt.
    expect(answer.tasks.some((task) => task.id === done.id)).toBe(false)
  })

  it("shows a task's Goal, Now, attention and link artifacts, and leaves out file artifacts (never chat or tool output)", () => {
    const workspace = sampleWorkspace(db)
    const caller = sampleTask(db, workspace.id)
    const other = sampleTask(db, workspace.id, 1_500)
    updateTask(db, other.id, {
      title: 'Fix the flaky login test',
      objective: 'Make the login test pass every run.',
      status: 'Reproduced locally; bisecting now.',
      activity: TaskActivity.Working,
    })
    addLinkArtifact(db, { taskId: other.id, url: 'https://github.com/acme/api/pull/42', title: 'Fix flaky login' })
    addArtifact(db, { taskId: other.id, path: 'notes.md', title: 'Working notes' })

    const [task] = otherTasksAnswer(db, caller.id).tasks.filter((entry) => entry.id === other.id)

    expect(task).toMatchObject({
      title: 'Fix the flaky login test',
      objective: 'Make the login test pass every run.',
      status: 'Reproduced locally; bisecting now.',
      attention: TaskAttention.Working,
      links: [{ title: 'Fix flaky login', url: 'https://github.com/acme/api/pull/42' }],
    })
  })

  it('reads attention by the one rule in src/shared/attention.ts, for working, needs you and idle', () => {
    const workspace = sampleWorkspace(db)
    const caller = sampleTask(db, workspace.id)
    const working = sampleTask(db, workspace.id, 1_100)
    updateTask(db, working.id, { activity: TaskActivity.Working })
    const needsYou = sampleTask(db, workspace.id, 1_200)
    updateTask(db, needsYou.id, { activity: TaskActivity.Error })
    const idle = sampleTask(db, workspace.id, 1_300)
    updateTask(db, idle.id, { activity: TaskActivity.Waiting })

    const byId = new Map(otherTasksAnswer(db, caller.id).tasks.map((task) => [task.id, task.attention]))

    expect(byId.get(working.id)).toBe(TaskAttention.Working)
    expect(byId.get(needsYou.id)).toBe(TaskAttention.NeedsYou)
    expect(byId.get(idle.id)).toBe(TaskAttention.Idle)
  })

  it('says nothing is set with an empty title, objective or status, rather than showing nothing', () => {
    const workspace = sampleWorkspace(db)
    const caller = sampleTask(db, workspace.id)

    const [self] = otherTasksAnswer(db, caller.id).tasks

    expect(self).toMatchObject({ title: '', objective: '', status: '', links: [] })
  })

  it('cuts a title, an objective, a status or a workspace name over its own length, and says the answer was cut', () => {
    const longName = 'W'.repeat(OTHER_TASKS_TEXT_MAX + 50)
    const workspace = createWorkspace(db, { name: longName, rootPath: '/code/long-name' }, 1_000)
    const caller = sampleTask(db, workspace.id)
    updateTask(db, caller.id, {
      title: 'T'.repeat(OTHER_TASKS_TEXT_MAX + 50),
      objective: 'O'.repeat(OTHER_TASKS_TEXT_MAX + 50),
      status: 'S'.repeat(OTHER_TASKS_TEXT_MAX + 50),
    })

    const answer = otherTasksAnswer(db, caller.id)
    const self = answer.tasks.find((task) => task.id === caller.id)
    if (self === undefined) throw new Error('caller not in its own answer')

    expect(answer.cut).toBe(true)
    for (const field of [self.title, self.objective, self.status, self.workspace] as const) {
      expect(field.length).toBe(OTHER_TASKS_TEXT_MAX)
      expect(field.endsWith('…')).toBe(true)
    }
  })

  it(
    "cuts a task's links to OTHER_TASKS_LINKS_MAX, keeping the most recently added (dropping the oldest) and " +
      "cutting a link's own title or url over its length",
    () => {
      const workspace = sampleWorkspace(db)
      const caller = sampleTask(db, workspace.id)
      for (let n = 1; n <= OTHER_TASKS_LINKS_MAX; n += 1) {
        addLinkArtifact(db, {
          taskId: caller.id,
          url: `https://github.com/acme/api/pull/${String(n)}`,
          title: `PR ${String(n)}`,
        })
      }
      // The newest link, declared last: too long, and still the one kept (the oldest, PR 1, is dropped instead).
      addLinkArtifact(db, {
        taskId: caller.id,
        url: `https://github.com/acme/api/pull/999?note=${'x'.repeat(OTHER_TASKS_LINK_TEXT_MAX + 20)}`,
        title: 'y'.repeat(OTHER_TASKS_LINK_TEXT_MAX + 20),
      })

      const answer = otherTasksAnswer(db, caller.id)
      const self = answer.tasks.find((task) => task.id === caller.id)
      if (self === undefined) throw new Error('caller not in its own answer')

      expect(answer.cut).toBe(true)
      expect(self.links).toHaveLength(OTHER_TASKS_LINKS_MAX)
      // The newest link (declared last, and too long) is kept, shortened, and listed first.
      expect(self.links[0]?.title.length).toBe(OTHER_TASKS_LINK_TEXT_MAX)
      expect(self.links[0]?.title.endsWith('…')).toBe(true)
      expect(self.links[0]?.url.length).toBe(OTHER_TASKS_LINK_TEXT_MAX)
      // Then the rest, newest first; the oldest link (PR 1) was dropped to make room.
      expect(self.links[1]).toEqual({
        title: `PR ${String(OTHER_TASKS_LINKS_MAX)}`,
        url: `https://github.com/acme/api/pull/${String(OTHER_TASKS_LINKS_MAX)}`,
      })
      expect(self.links.some((link) => link.title === 'PR 1')).toBe(false)
    },
  )

  it('keeps the 20 most recently added links when there are 25, newest first', () => {
    const workspace = sampleWorkspace(db)
    const caller = sampleTask(db, workspace.id)
    for (let n = 1; n <= 25; n += 1) {
      addLinkArtifact(db, {
        taskId: caller.id,
        url: `https://github.com/acme/api/pull/${String(n)}`,
        title: `PR ${String(n)}`,
      })
    }

    const answer = otherTasksAnswer(db, caller.id)
    const self = answer.tasks.find((task) => task.id === caller.id)
    if (self === undefined) throw new Error('caller not in its own answer')

    expect(answer.cut).toBe(true)
    expect(self.links).toHaveLength(OTHER_TASKS_LINKS_MAX)
    expect(self.links.map((link) => link.title)).toEqual(
      Array.from({ length: OTHER_TASKS_LINKS_MAX }, (_, i) => `PR ${String(25 - i)}`),
    )
  })

  it('bounds the number of tasks to OTHER_TASKS_MAX, but always keeps the caller even past the cap', () => {
    const workspace = sampleWorkspace(db)
    const caller = sampleTask(db, workspace.id, 1_000)
    for (let n = 0; n < OTHER_TASKS_MAX; n += 1) {
      sampleTask(db, workspace.id, 2_000 + n)
    }

    const answer = otherTasksAnswer(db, caller.id)

    expect(answer.cut).toBe(true)
    expect(answer.tasks).toHaveLength(OTHER_TASKS_MAX)
    expect(answer.tasks.some((task) => task.isSelf)).toBe(true)
    expect(answer.tasks.find((task) => task.isSelf)?.id).toBe(caller.id)
  })

  it("doesn't cut when the caller already falls inside the cap", () => {
    const workspace = sampleWorkspace(db)
    const caller = sampleTask(db, workspace.id, 9_000)
    for (let n = 0; n < OTHER_TASKS_MAX - 1; n += 1) {
      sampleTask(db, workspace.id, 1_000 + n)
    }

    const answer = otherTasksAnswer(db, caller.id)

    expect(answer.cut).toBe(false)
    expect(answer.tasks).toHaveLength(OTHER_TASKS_MAX)
  })
})

describe('otherTasksText', () => {
  it('says there are none when there are none', () => {
    expect(otherTasksText({ tasks: [], cut: false })).toBe('No other Active tasks right now.')
  })

  it('renders a header with the count and whether it was cut, then a block per task', () => {
    const workspace = sampleWorkspace(db)
    const caller = sampleTask(db, workspace.id)
    updateTask(db, caller.id, {
      title: 'Fix the flaky login test',
      objective: 'Make the login test pass every run.',
      status: 'Reproduced locally.',
      activity: TaskActivity.Working,
    })
    addLinkArtifact(db, { taskId: caller.id, url: 'https://github.com/acme/api/pull/42', title: 'Fix flaky login' })

    const text = otherTasksText(otherTasksAnswer(db, caller.id))

    expect(text).toContain('1 Active task, most recently updated first:')
    expect(text).toContain(`- ${caller.id} (this task, itself): "Fix the flaky login test"`)
    expect(text).toContain('working')
    expect(text).toContain('Goal: Make the login test pass every run.')
    expect(text).toContain('Now: Reproduced locally.')
    expect(text).toContain('Links: "Fix flaky login" https://github.com/acme/api/pull/42')
    expect(text).not.toContain('cut:')
  })

  it('says the answer was cut when it was, and marks an untitled task and unset fields', () => {
    const workspace = sampleWorkspace(db)
    const caller = sampleTask(db, workspace.id)

    const text = otherTasksText({
      tasks: [
        {
          id: caller.id,
          title: '',
          objective: '',
          status: '',
          attention: TaskAttention.Idle,
          workspace: 'Acme API',
          updatedAt: 1_000,
          links: [],
          isSelf: true,
        },
      ],
      cut: true,
    })

    expect(text).toContain('(cut: some tasks, links or long fields were left out or shortened)')
    expect(text).toContain('(untitled)')
    expect(text).toContain('Goal: (not set)')
    expect(text).toContain('Now: (not set)')
    expect(text).toContain('Links: none')
  })

  it('pluralises the count for more than one task', () => {
    const workspace = sampleWorkspace(db)
    const first: Task = sampleTask(db, workspace.id, 1_000)
    const second: Task = sampleTask(db, workspace.id, 2_000)

    const text = otherTasksText(otherTasksAnswer(db, first.id))

    expect(text).toContain('2 Active tasks, most recently updated first:')
    expect(text).toContain(first.id)
    expect(text).toContain(second.id)
  })

  it('writes each attention in plain words: working, needs you and idle', () => {
    const workspace = sampleWorkspace(db)
    const caller = sampleTask(db, workspace.id)
    const working = sampleTask(db, workspace.id, 1_100)
    updateTask(db, working.id, { activity: TaskActivity.Working })
    const needsYou = sampleTask(db, workspace.id, 1_200)
    updateTask(db, needsYou.id, { activity: TaskActivity.Error })

    const text = otherTasksText(otherTasksAnswer(db, caller.id))

    expect(text).toContain(`- ${working.id}: (untitled) — in Acme API, working, updated`)
    expect(text).toContain(`- ${needsYou.id}: (untitled) — in Acme API, needs you, updated`)
    expect(text).toContain(`- ${caller.id} (this task, itself): (untitled) — in Acme API, idle, updated`)
  })
})
