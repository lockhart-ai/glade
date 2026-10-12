import { mkdtemp, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { liveTodoIds, sdkTaskList, sharedTaskListDir } from './task-list'
vi.mock('node:fs/promises', { spy: true })
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glade-task-list-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

it('does not mistake an unreadable legacy list for an empty list', async () => {
  const original = join(dir, 'old')
  await writeFile(original, 'This should have been a directory')
  await expect(
    sdkTaskList({
      taskId: 'task',
      sessionId: 'session',
      dataDir: dir,
      configDir: join(dir, 'claude'),
      legacyConfigDir: original,
    }),
  ).rejects.toThrow('ENOTDIR')
})

it('reports failed publication of a seeded list and can retry it', async () => {
  const options = {
    taskId: 'task',
    sessionId: null,
    dataDir: dir,
    configDir: join(dir, 'claude'),
    legacyConfigDir: join(dir, 'old'),
  }
  vi.mocked(rename).mockRejectedValueOnce(new Error('Cannot publish the task list'))
  await expect(sdkTaskList(options)).rejects.toThrow('Cannot publish the task list')
  expect(await sdkTaskList(options)).toBe('glade-task')
})

it('reports a failed link instead of starting with an unrelated empty task list', async () => {
  const options = {
    taskId: 'task',
    sessionId: null,
    dataDir: dir,
    configDir: join(dir, 'claude'),
    legacyConfigDir: join(dir, 'old'),
  }
  vi.mocked(symlink).mockRejectedValueOnce(new Error('Cannot link the task list'))
  await expect(sdkTaskList(options)).rejects.toThrow('Cannot link the task list')
  expect(await sdkTaskList(options)).toBe('glade-task')
})

it.each(['claude', 'router'])(
  'keeps todo ids, edits and the high-water mark across a switch from %s and back',
  async (source) => {
    const original = join(dir, source)
    const other = join(dir, source === 'claude' ? 'router' : 'claude')
    await mkdir(join(original, 'tasks', 'sdk-session'), { recursive: true })
    await writeFile(join(original, 'tasks', 'sdk-session', '7.json'), '{"id":"7","status":"pending"}')
    await writeFile(join(original, 'tasks', 'sdk-session', '.highwatermark'), '9')
    const options = {
      taskId: 'glade-task',
      sessionId: 'sdk-session',
      dataDir: dir,
      legacyConfigDir: original,
      configDir: other,
    }
    const id = await sdkTaskList(options)
    if (id === undefined) throw new Error('Shared task list missing')
    const path = join(other, 'tasks', id)
    expect(await readFile(join(path, '.highwatermark'), 'utf8')).toBe('9')
    await writeFile(join(path, '7.json'), '{"id":"7","status":"completed"}')
    await writeFile(join(path, '.highwatermark'), '10')
    await sdkTaskList({ ...options, configDir: original })
    expect(await readFile(join(original, 'tasks', id, '7.json'), 'utf8')).toContain('completed')
    expect(await readFile(join(original, 'tasks', id, '.highwatermark'), 'utf8')).toBe('10')
    expect(await readlink(join(original, 'tasks', id))).toBe(await readlink(path))
    // The pre-migration list is preserved, never overwritten.
    expect(await readFile(join(original, 'tasks', 'sdk-session', '.highwatermark'), 'utf8')).toBe('9')
  },
)

it('shares a fresh list between concurrent parents and children and rejects an unrelated existing link', async () => {
  const options = {
    taskId: 'task:1',
    sessionId: null,
    dataDir: dir,
    legacyConfigDir: join(dir, 'old'),
    configDir: join(dir, 'claude'),
  }
  const [first, second] = await Promise.all([sdkTaskList(options), sdkTaskList(options)])
  expect(first).toBe('glade-task-1')
  expect(second).toBe(first)
  if (first === undefined) throw new Error('Shared task list missing')
  await sdkTaskList({ ...options, sessionId: 'absent' })
  await mkdir(join(dir, 'wrong', 'tasks'), { recursive: true })
  await symlink(dir, join(dir, 'wrong', 'tasks', first))
  await expect(sdkTaskList({ ...options, configDir: join(dir, 'wrong') })).rejects.toThrow('different task')
})

it('leaves an ordinary task alone until a cross-source session creates its shared list', async () => {
  const options = {
    taskId: 'ordinary',
    sessionId: 'session',
    dataDir: dir,
    configDir: join(dir, 'claude'),
    legacyConfigDir: join(dir, 'claude'),
    create: false,
  }
  expect(await sdkTaskList(options)).toBeUndefined()
  await expect(readFile(join(dir, 'sdk-task-lists', 'ordinary'))).rejects.toThrow('ENOENT')
  expect(await sdkTaskList({ ...options, configDir: join(dir, 'router'), create: true })).toBe('glade-ordinary')
  expect(await sdkTaskList(options)).toBe('glade-ordinary')
})

it('gives every main session of a task the same shared list, seeded once from the first session', async () => {
  await mkdir(join(dir, 'claude', 'tasks', 'first-session'), { recursive: true })
  await writeFile(join(dir, 'claude', 'tasks', 'first-session', '3.json'), '{"id":"3","status":"pending"}')
  const options = {
    taskId: 'steady',
    sessionId: 'first-session',
    dataDir: dir,
    configDir: join(dir, 'claude'),
    legacyConfigDir: join(dir, 'claude'),
  }
  expect(await sdkTaskList(options)).toBe('glade-steady')
  // A restart that resumes a different session id, or the same one, lands on the list that was seeded.
  const second = await sdkTaskList({ ...options, sessionId: 'second-session', configDir: join(dir, 'router') })
  expect(second).toBe('glade-steady')
  expect(await readFile(join(dir, 'sdk-task-lists', 'steady', '3.json'), 'utf8')).toContain('pending')
})

it('raises a seeded list past the highest todo id Glade holds, whatever the legacy mark said', async () => {
  const options = {
    taskId: 'seeded',
    sessionId: 'legacy-session',
    dataDir: dir,
    configDir: join(dir, 'claude'),
    legacyConfigDir: join(dir, 'claude'),
  }
  await mkdir(join(dir, 'claude', 'tasks', 'legacy-session'), { recursive: true })
  await writeFile(join(dir, 'claude', 'tasks', 'legacy-session', '.highwatermark'), '9')
  await sdkTaskList({ ...options, highestTodoId: 52 })
  expect(await readFile(join(dir, 'sdk-task-lists', 'seeded', '.highwatermark'), 'utf8')).toBe('53')
  // A mark that already stands higher than Glade's highest todo is left alone.
  await rm(join(dir, 'sdk-task-lists', 'seeded'), { recursive: true, force: true })
  await writeFile(join(dir, 'claude', 'tasks', 'legacy-session', '.highwatermark'), '60')
  await sdkTaskList({ ...options, highestTodoId: 52 })
  expect(await readFile(join(dir, 'sdk-task-lists', 'seeded', '.highwatermark'), 'utf8')).toBe('60')
})

it('marks a list seeded without a legacy one past the highest todo id Glade holds', async () => {
  const options = {
    taskId: 'fresh',
    sessionId: null,
    dataDir: dir,
    configDir: join(dir, 'claude'),
    legacyConfigDir: join(dir, 'claude'),
  }
  await sdkTaskList({ ...options, highestTodoId: 12 })
  expect(await readFile(join(dir, 'sdk-task-lists', 'fresh', '.highwatermark'), 'utf8')).toBe('13')
})

it('leaves a shared list that already exists alone, whatever Glade holds', async () => {
  const options = {
    taskId: 'running',
    sessionId: null,
    dataDir: dir,
    configDir: join(dir, 'claude'),
    legacyConfigDir: join(dir, 'claude'),
  }
  await sdkTaskList(options)
  await writeFile(join(dir, 'sdk-task-lists', 'running', '.highwatermark'), '5')
  await sdkTaskList({ ...options, highestTodoId: 52 })
  expect(await readFile(join(dir, 'sdk-task-lists', 'running', '.highwatermark'), 'utf8')).toBe('5')
})

it('reads the live todo ids by file name alone, and none where there is no shared list', async () => {
  const folder = sharedTaskListDir(dir, 'task:1')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, '1.json'), '{"id":"1","status":"pending"}')
  await writeFile(join(folder, '52.json'), '{"id":"52","status":"completed"}')
  await writeFile(join(folder, '.highwatermark'), '60')
  await writeFile(join(folder, '.lock'), '')
  expect(liveTodoIds(dir, 'task:1')).toEqual(new Set(['1', '52']))
  // A folder entry that names nothing — a link to a file gone, say — is not live.
  await symlink(join(folder, 'gone.json'), join(folder, '9.json'))
  expect(liveTodoIds(dir, 'task:1')).toEqual(new Set(['1', '52']))
  expect(liveTodoIds(dir, 'never-started')).toBeNull()
})
