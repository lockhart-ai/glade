import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskActivity, TaskState, UiStateKey } from '../shared/domain'
import { applySeed, readSeed, type CaptureSeed } from './capture-seed'
import { listTasks } from './db/repositories/tasks'
import { getUiState } from './db/repositories/ui-state'
import { listWorkspaces } from './db/repositories/workspaces'
import { openTestDatabase, type TestDatabase } from './db/repositories/test-database'
import { DEFAULT_EFFORT, DEFAULT_MODEL } from './tasks/defaults'

const FIXTURE = join(import.meta.dirname, '..', '..', 'scripts', 'fixtures', 'task-workspace.json')
const NOW = 10_000_000
const MINUTE = 60_000

const SEED: CaptureSeed = {
  workspace: { name: 'Acme API', rootPath: '/Users/sample/code/api' },
  tasks: [
    { title: 'Add rate limiting', status: 'Waiting on you', minutesAgo: 4, selected: true },
    { title: 'Move uploads', activity: TaskActivity.Working, minutesAgo: 30 },
    {
      title: 'Upgrade Django',
      objective: 'Move to 5.2',
      state: TaskState.Done,
      pinned: true,
      unread: true,
      minutesAgo: 60,
    },
  ],
}

describe('readSeed', () => {
  let folder: string

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'glade-seed-'))
  })

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
  })

  function write(content: string): string {
    const path = join(folder, 'seed.json')
    writeFileSync(path, content)
    return path
  }

  it('reads a fixture', () => {
    expect(readSeed(write(JSON.stringify(SEED)))).toEqual(SEED)
  })

  it('reads the task workspace fixture', () => {
    expect(readSeed(FIXTURE).workspace.name).toBe('Acme API')
  })

  it('refuses a fixture that is missing or not JSON', () => {
    expect(() => readSeed(join(folder, 'missing.json'))).toThrow(/^the seed .*missing\.json can't be read: /)
    expect(() => readSeed(write('{'))).toThrow(/can't be read: /)
  })

  it('refuses a fixture that is not valid', () => {
    expect(() => readSeed(write(JSON.stringify({ ...SEED, extra: 1 })))).toThrow(/is invalid: /)
    expect(() => readSeed(write(JSON.stringify({ ...SEED, tasks: [{ title: 'x', minutesAgo: -1 }] })))).toThrow(
      /is invalid: /,
    )
  })
})

describe('applySeed', () => {
  let database: TestDatabase

  beforeEach(() => {
    database = openTestDatabase()
  })

  afterEach(() => {
    database.close()
  })

  it('adds the workspace, opened, and its tasks, updated the given minutes ago', () => {
    const { db } = database

    applySeed(db, SEED, NOW)

    const [workspace] = listWorkspaces(db)
    expect(workspace).toMatchObject({ name: 'Acme API', rootPath: '/Users/sample/code/api', lastOpenedAt: NOW })
    const tasks = listTasks(db, workspace?.id ?? '')
    expect(tasks).toMatchObject([
      {
        title: 'Add rate limiting',
        objective: '',
        status: 'Waiting on you',
        state: TaskState.Active,
        pinned: false,
        unread: false,
        model: DEFAULT_MODEL,
        effort: DEFAULT_EFFORT,
        updatedAt: NOW - 4 * MINUTE,
        doneAt: null,
        activity: TaskActivity.Waiting,
      },
      { title: 'Move uploads', activity: TaskActivity.Working },
      {
        title: 'Upgrade Django',
        objective: 'Move to 5.2',
        state: TaskState.Done,
        pinned: true,
        unread: true,
        updatedAt: NOW - 60 * MINUTE,
        doneAt: NOW - 60 * MINUTE,
      },
    ])
    expect(getUiState(db, UiStateKey.ActiveWorkspaceId)).toBe(workspace?.id)
    expect(getUiState(db, UiStateKey.SelectedTaskId)).toBe(tasks[0]?.id)
  })

  it('selects nothing unless a task asks to be', () => {
    const { db } = database

    applySeed(db, { ...SEED, tasks: [{ title: 'Only', minutesAgo: 0 }] })

    expect(getUiState(db, UiStateKey.SelectedTaskId)).toBeUndefined()
  })
})
