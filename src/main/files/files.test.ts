import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeErrorCode, EventType, type GladeEvent } from '../../shared/bridge'
import { FileContentKind } from '../../shared/domain'
import { MAX_FILE_BYTES, MAX_FILE_LINES } from '../../shared/files'
import { CommandFailure } from '../bridge/errors'
import { getOpenFiles } from '../db/repositories/open-files'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import {
  closeTaskFile,
  openTaskFile,
  openTaskFileInEditor,
  readTaskFile,
  readWorkspaceFile,
  resolveWorkspaceFile,
  showTaskFile,
  type FilesContext,
} from './files'

let folder: string
let root: string
let outside: string
let database: TestDatabase
let events: GladeEvent[]
let context: FilesContext
let taskId: string

function write(path: string, content: string | Buffer): void {
  const full = join(root, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

beforeEach(() => {
  // The temp folder is behind a symlink on macOS (/var → /private/var): the checks must hold either way.
  folder = mkdtempSync(join(tmpdir(), 'glade-files-'))
  root = join(folder, 'acme-api')
  outside = join(folder, 'secrets')
  mkdirSync(root)
  mkdirSync(outside)
  writeFileSync(join(outside, 'token.txt'), 'hunter2')
  database = openTestDatabase()
  events = []
  context = { db: database.db, emit: (event) => events.push(event), openPath: vi.fn(() => Promise.resolve('')) }
  taskId = sampleTask(database.db, sampleWorkspace(database.db, root).id).id
})

afterEach(() => {
  database.close()
  rmSync(folder, { recursive: true, force: true })
})

async function failure(promise: Promise<unknown>): Promise<CommandFailure> {
  try {
    await promise
  } catch (error) {
    if (error instanceof CommandFailure) return error
    throw error
  }
  throw new Error('It did not fail')
}

describe('resolveWorkspaceFile', () => {
  it('resolves a file inside the root to its real path, through symlinks that stay inside', async () => {
    write('docs/rate-limits.md', '# Rate limits\n')
    symlinkSync(join(root, 'docs'), join(root, 'notes'))

    const real = realpathSync(join(root, 'docs', 'rate-limits.md'))
    await expect(resolveWorkspaceFile(root, 'docs/rate-limits.md')).resolves.toBe(real)
    await expect(resolveWorkspaceFile(root, 'notes/rate-limits.md')).resolves.toBe(real)
  })

  it('answers null when there is nothing there, or no root', async () => {
    await expect(resolveWorkspaceFile(root, 'docs/missing.md')).resolves.toBeNull()
    write('README.md', 'Hi')
    await expect(resolveWorkspaceFile(root, 'README.md/child')).resolves.toBeNull()
    await expect(resolveWorkspaceFile(join(folder, 'gone'), 'README.md')).resolves.toBeNull()
  })

  it('refuses a path that climbs out of the root', async () => {
    for (const path of ['../secrets/token.txt', 'docs/../../secrets/token.txt', '..', join(outside, 'token.txt')]) {
      const refused = await failure(resolveWorkspaceFile(root, path))
      expect(refused.code, path).toBe(BridgeErrorCode.OutsideWorkspace)
    }
  })

  it('refuses a symlink that leads out of the root, to a file or through a folder', async () => {
    symlinkSync(join(outside, 'token.txt'), join(root, 'token.txt'))
    symlinkSync(outside, join(root, 'vendor'))

    expect((await failure(resolveWorkspaceFile(root, 'token.txt'))).code).toBe(BridgeErrorCode.OutsideWorkspace)
    expect((await failure(resolveWorkspaceFile(root, 'vendor/token.txt'))).code).toBe(BridgeErrorCode.OutsideWorkspace)
  })

  it('passes on any other error from the file system', async () => {
    write('private/notes.md', 'Hi')
    chmodSync(join(root, 'private'), 0o000)
    try {
      await expect(resolveWorkspaceFile(root, 'private/notes.md')).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      chmodSync(join(root, 'private'), 0o755)
    }
  })

  it('passes on an error resolving the root other than its absence', async () => {
    write('private/notes.md', 'Hi')
    chmodSync(join(root, 'private'), 0o000)
    try {
      await expect(resolveWorkspaceFile(join(root, 'private', 'inner'), 'x')).rejects.toMatchObject({
        code: 'EACCES',
      })
    } finally {
      chmodSync(join(root, 'private'), 0o755)
    }
  })
})

describe('readWorkspaceFile', () => {
  it('reads a text file whole, with its size', async () => {
    write('src/date.ts', 'export const today = () => new Date()\n')

    await expect(readWorkspaceFile(root, 'src/date.ts')).resolves.toEqual({
      kind: FileContentKind.Text,
      text: 'export const today = () => new Date()\n',
      truncated: false,
      size: 38,
    })
  })

  it('says a file with a NUL byte is binary, and a folder or a missing file is missing', async () => {
    write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
    mkdirSync(join(root, 'src'))

    await expect(readWorkspaceFile(root, 'logo.png')).resolves.toEqual({ kind: FileContentKind.Binary, size: 6 })
    await expect(readWorkspaceFile(root, 'src')).resolves.toEqual({ kind: FileContentKind.Missing })
    await expect(readWorkspaceFile(root, 'gone.ts')).resolves.toEqual({ kind: FileContentKind.Missing })
  })

  it('cuts a file too large to show to its first whole lines', async () => {
    const line = `${'x'.repeat(99)}\n`
    const count = Math.ceil(MAX_FILE_BYTES / line.length) + 10
    write('big.log', line.repeat(count))

    const content = await readWorkspaceFile(root, 'big.log')

    expect(content).toMatchObject({ kind: FileContentKind.Text, truncated: true, size: line.length * count })
    if (content.kind !== FileContentKind.Text) throw new Error('Not text')
    expect(content.text.endsWith('\n')).toBe(true)
    expect(content.text.split('\n').every((read) => read === '' || read.length === 99)).toBe(true)
  })

  it('keeps a single line too large to show as far as it reads', async () => {
    write('min.js', 'x'.repeat(MAX_FILE_BYTES + 5))

    const content = await readWorkspaceFile(root, 'min.js')

    expect(content).toMatchObject({ kind: FileContentKind.Text, truncated: true })
    if (content.kind !== FileContentKind.Text) throw new Error('Not text')
    expect(content.text).toHaveLength(MAX_FILE_BYTES)
  })

  it('cuts a file with too many lines to its first lines', async () => {
    write('long.txt', 'line\n'.repeat(MAX_FILE_LINES + 1))
    write('exact.txt', 'line\n'.repeat(MAX_FILE_LINES))
    write('no-newline.txt', `${'line\n'.repeat(MAX_FILE_LINES - 1)}line`)

    const long = await readWorkspaceFile(root, 'long.txt')
    expect(long).toMatchObject({ kind: FileContentKind.Text, truncated: true })
    if (long.kind !== FileContentKind.Text) throw new Error('Not text')
    expect(long.text).toBe('line\n'.repeat(MAX_FILE_LINES))
    await expect(readWorkspaceFile(root, 'exact.txt')).resolves.toMatchObject({ truncated: false })
    await expect(readWorkspaceFile(root, 'no-newline.txt')).resolves.toMatchObject({ truncated: false })
  })

  it('refuses a file outside the root', async () => {
    symlinkSync(join(outside, 'token.txt'), join(root, 'token.txt'))

    expect((await failure(readWorkspaceFile(root, 'token.txt'))).code).toBe(BridgeErrorCode.OutsideWorkspace)
  })
})

describe('the task commands', () => {
  it('read a file of the task’s workspace, and fail for a task that is gone', async () => {
    write('README.md', '# Acme API\n')

    await expect(readTaskFile(context, taskId, 'README.md')).resolves.toMatchObject({ text: '# Acme API\n' })
    expect((await failure(readTaskFile(context, 'gone', 'README.md'))).code).toBe(BridgeErrorCode.NotFound)
  })

  it('open and close tabs, keep them, and tell the windows', () => {
    openTaskFile(context, taskId, 'docs/rate-limits.md')
    openTaskFile(context, taskId, 'api/throttles.py')
    const closed = closeTaskFile(context, taskId, 'api/throttles.py')

    expect(closed).toEqual({ taskId, paths: ['docs/rate-limits.md'], activePath: 'docs/rate-limits.md' })
    expect(getOpenFiles(database.db, taskId)).toEqual(closed)
    expect(events.map((event) => event.type)).toEqual([
      EventType.OpenFilesChanged,
      EventType.OpenFilesChanged,
      EventType.OpenFilesChanged,
    ])
    expect(() => openTaskFile(context, 'gone', 'README.md')).toThrow(CommandFailure)
  })

  it('open a file in the editor by its real path, or fail when it is missing or macOS can’t', async () => {
    write('README.md', '# Acme API\n')

    await openTaskFileInEditor(context, taskId, 'README.md')
    expect(context.openPath).toHaveBeenCalledExactlyOnceWith(realpathSync(join(root, 'README.md')))

    expect((await failure(openTaskFileInEditor(context, taskId, 'gone.md'))).code).toBe(BridgeErrorCode.NotFound)
    vi.mocked(context.openPath).mockResolvedValueOnce('No application knows how to open it')
    await expect(openTaskFileInEditor(context, taskId, 'README.md')).rejects.toThrow(
      "Couldn't open README.md: No application knows how to open it",
    )
  })
})

describe('showTaskFile', () => {
  it('opens a file by a path relative to the root or absolute, and asks the window to show it at the line', async () => {
    write('docs/rate-limits.md', '# Rate limits\n')

    await expect(showTaskFile(context, taskId, 'docs/rate-limits.md', 8)).resolves.toBe('docs/rate-limits.md')
    await expect(showTaskFile(context, taskId, join(root, 'docs', 'rate-limits.md'), null)).resolves.toBe(
      'docs/rate-limits.md',
    )

    expect(getOpenFiles(database.db, taskId).paths).toEqual(['docs/rate-limits.md'])
    expect(events.filter((event) => event.type === EventType.FileShown)).toEqual([
      { type: EventType.FileShown, taskId, path: 'docs/rate-limits.md', line: 8 },
      { type: EventType.FileShown, taskId, path: 'docs/rate-limits.md', line: null },
    ])
  })

  it('refuses a path outside the workspace, a missing file or a folder, opening nothing', async () => {
    mkdirSync(join(root, 'docs'))
    symlinkSync(join(outside, 'token.txt'), join(root, 'token.txt'))

    await expect(showTaskFile(context, taskId, join(outside, 'token.txt'), null)).rejects.toThrow(
      'is outside the workspace',
    )
    await expect(showTaskFile(context, taskId, 'token.txt', null)).rejects.toThrow('is outside the workspace')
    await expect(showTaskFile(context, taskId, 'gone.md', null)).rejects.toThrow("There's no file at gone.md.")
    await expect(showTaskFile(context, taskId, 'docs', null)).rejects.toThrow("There's no file at docs.")
    expect(events).toEqual([])
  })
})
