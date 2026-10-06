import { mkdtemp, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sdkTaskList } from './task-list'
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
