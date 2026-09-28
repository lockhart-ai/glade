import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { BridgeErrorCode, EventType, type GladeEvent } from '../../shared/bridge'
import { FileContentKind, FileThumbnailKind } from '../../shared/domain'
import { MAX_FILE_BYTES, MAX_FILE_LINES, MAX_SAVE_BYTES } from '../../shared/files'
import { MAX_THUMBNAIL_SOURCE_BYTES, type Thumbnails } from '../artifacts/thumbnails'
import { CommandFailure } from '../bridge/errors'
import { getOpenFiles } from '../db/repositories/open-files'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import {
  closeTaskFile,
  copyTaskFile,
  thumbnailOfTaskFile,
  MAX_ARTIFACT_BYTES,
  openTaskFile,
  openTaskFileInEditor,
  readTaskFile,
  readWorkspaceFile,
  resolveWorkspaceFile,
  revealTaskFile,
  saveFailure,
  showTaskFile,
  writeTaskFile,
  writeWorkspaceFile,
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
  context = {
    db: database.db,
    emit: (event) => events.push(event),
    openPath: vi.fn(() => Promise.resolve('')),
    revealPath: vi.fn(),
    writeClipboard: vi.fn(() => Promise.resolve()),
  }
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

describe('thumbnailOfTaskFile', () => {
  const changed = new Date(1_700_000_000_000)
  const URL = 'data:image/png;base64,iVBORw0KGgo='

  function thumbnails(url: string | null = URL): Thumbnails & { thumbnailOf: Mock<Thumbnails['thumbnailOf']> } {
    return { thumbnailOf: vi.fn<Thumbnails['thumbnailOf']>(() => Promise.resolve(url)) }
  }

  /** How each kind of image starts, and a little after. */
  const IMAGES: Readonly<Record<string, Buffer>> = {
    png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR')]),
    jpg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    gif: Buffer.from('GIF89a\x01\x00'),
    webp: Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 '),
    svg: Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),
  }

  it('makes an image’s thumbnail from its real path, size and last change, whatever case its extension', async () => {
    write('out/screens/landing-dark.png', IMAGES.png ?? '')
    write('out/screens/Search.JPEG', IMAGES.jpg ?? '')
    utimesSync(join(root, 'out', 'screens', 'landing-dark.png'), changed, changed)
    const made = thumbnails()

    await expect(thumbnailOfTaskFile(context, made, taskId, 'out/screens/landing-dark.png')).resolves.toEqual({
      kind: FileThumbnailKind.Image,
      dataUrl: URL,
    })
    await expect(thumbnailOfTaskFile(context, made, taskId, 'out/screens/Search.JPEG')).resolves.toMatchObject({
      kind: FileThumbnailKind.Image,
    })

    expect(made.thumbnailOf.mock.calls[0]).toEqual([
      {
        realPath: realpathSync(join(root, 'out', 'screens', 'landing-dark.png')),
        size: 12,
        modifiedMs: changed.getTime(),
      },
    ])
  })

  it('makes every kind of image the tab shows: PNG, JPEG, GIF, WebP and SVG', async () => {
    const made = thumbnails()
    for (const name of ['a.png', 'b.jpg', 'c.jpeg', 'd.gif', 'e.webp', 'f.svg']) {
      write(name, IMAGES[name.slice(2) === 'jpeg' ? 'jpg' : name.slice(2)] ?? '')
      await expect(thumbnailOfTaskFile(context, made, taskId, name)).resolves.toMatchObject({
        kind: FileThumbnailKind.Image,
      })
    }
    expect(made.thumbnailOf.mock.calls).toHaveLength(6)
  })

  it('has none for a file that isn’t an image, an image too large, or one no thumbnail can be made of', async () => {
    write('docs/notes.md', '# Notes\n')
    write('Makefile', 'all:\n')
    write('huge.png', IMAGES.png ?? '')
    // Sparse: as large as it says without taking the room.
    truncateSync(join(root, 'huge.png'), MAX_THUMBNAIL_SOURCE_BYTES + 1)
    write('broken.png', IMAGES.png ?? '')
    const made = thumbnails()

    await expect(thumbnailOfTaskFile(context, made, taskId, 'docs/notes.md')).resolves.toEqual({
      kind: FileThumbnailKind.None,
    })
    await expect(thumbnailOfTaskFile(context, made, taskId, 'Makefile')).resolves.toEqual({
      kind: FileThumbnailKind.None,
    })
    await expect(thumbnailOfTaskFile(context, made, taskId, 'huge.png')).resolves.toEqual({
      kind: FileThumbnailKind.None,
    })
    expect(made.thumbnailOf.mock.calls).toEqual([])
    await expect(thumbnailOfTaskFile(context, thumbnails(null), taskId, 'broken.png')).resolves.toEqual({
      kind: FileThumbnailKind.None,
    })
  })

  it('has none for a file that doesn’t start as the image its name says, without asking for one', async () => {
    write('screens/cut-short.png', Buffer.from([0x89, 0x50]))
    write('screens/empty.png', '')
    write('screens/named-wrong.png', IMAGES.jpg ?? '')
    write('logo.svg', '<html><body>not an svg</body></html>')
    write('photo.webp', 'RIFF\x10\x00\x00\x00WAVEfmt ')
    const made = thumbnails()

    for (const path of [
      'screens/cut-short.png',
      'screens/empty.png',
      'screens/named-wrong.png',
      'logo.svg',
      'photo.webp',
    ]) {
      await expect(thumbnailOfTaskFile(context, made, taskId, path), path).resolves.toEqual({
        kind: FileThumbnailKind.None,
      })
    }
    expect(made.thumbnailOf.mock.calls).toEqual([])
  })

  it('is missing for no file, or a folder, and refuses a path outside the workspace', async () => {
    mkdirSync(join(root, 'docs.png'))
    symlinkSync(join(outside, 'token.txt'), join(root, 'token.png'))
    const made = thumbnails()

    await expect(thumbnailOfTaskFile(context, made, taskId, 'docs/gone.png')).resolves.toEqual({
      kind: FileThumbnailKind.Missing,
    })
    await expect(thumbnailOfTaskFile(context, made, taskId, 'docs.png')).resolves.toEqual({
      kind: FileThumbnailKind.Missing,
    })
    expect((await failure(thumbnailOfTaskFile(context, made, taskId, 'token.png'))).code).toBe(
      BridgeErrorCode.OutsideWorkspace,
    )
    expect((await failure(thumbnailOfTaskFile(context, made, 'gone', 'a.png'))).code).toBe(BridgeErrorCode.NotFound)
    expect(made.thumbnailOf.mock.calls).toEqual([])
  })
})

describe('copyTaskFile', () => {
  it('puts a text file’s contents on the clipboard', async () => {
    write('out/email.txt', 'Hi all,\n\n2.4 is out.\n')

    await copyTaskFile(context, taskId, 'out/email.txt')

    expect(context.writeClipboard).toHaveBeenCalledExactlyOnceWith('Hi all,\n\n2.4 is out.\n')
  })

  it('refuses a missing, binary or too large file, or one outside the workspace, copying nothing', async () => {
    write('logo.png', Buffer.from([0x89, 0x00]))
    write('dump.sql', Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 0x41))
    symlinkSync(join(outside, 'token.txt'), join(root, 'token.txt'))

    expect((await failure(copyTaskFile(context, taskId, 'gone.md'))).code).toBe(BridgeErrorCode.NotFound)
    expect((await failure(copyTaskFile(context, taskId, 'logo.png'))).code).toBe(BridgeErrorCode.InvalidRequest)
    expect((await failure(copyTaskFile(context, taskId, 'dump.sql'))).code).toBe(BridgeErrorCode.InvalidRequest)
    expect((await failure(copyTaskFile(context, taskId, 'token.txt'))).code).toBe(BridgeErrorCode.OutsideWorkspace)
    expect(context.writeClipboard).not.toHaveBeenCalled()
  })
})

describe('revealTaskFile', () => {
  it('shows a file in Finder by its real path', async () => {
    write('docs/notes.md', '# Notes\n')

    await revealTaskFile(context, taskId, 'docs/notes.md')

    expect(context.revealPath).toHaveBeenCalledExactlyOnceWith(realpathSync(join(root, 'docs', 'notes.md')))
  })

  it('refuses a file that isn’t there, revealing nothing', async () => {
    expect((await failure(revealTaskFile(context, taskId, 'gone.md'))).code).toBe(BridgeErrorCode.NotFound)
    expect(context.revealPath).not.toHaveBeenCalled()
  })
})

describe('writeWorkspaceFile', () => {
  /** What's in a file, inside the workspace or out. */
  const read = (path: string): string => readFileSync(path, 'utf8')

  it('writes a file over in place, keeping its permissions and any hard link to it', async () => {
    write('docs/rate-limits.md', '# Rate limits\n\nOld text that is longer than the new.\n')
    chmodSync(join(root, 'docs', 'rate-limits.md'), 0o640)
    linkSync(join(root, 'docs', 'rate-limits.md'), join(root, 'linked.md'))

    await writeWorkspaceFile(root, 'docs/rate-limits.md', '# Rate limits\n\nNew — ünïcode.\n')

    expect(read(join(root, 'docs', 'rate-limits.md'))).toBe('# Rate limits\n\nNew — ünïcode.\n')
    expect(read(join(root, 'linked.md'))).toBe('# Rate limits\n\nNew — ünïcode.\n')
    expect(statSync(join(root, 'docs', 'rate-limits.md')).mode & 0o777).toBe(0o640)
  })

  it('writes through a symlink that stays inside the root, to the file it leads to', async () => {
    write('docs/rate-limits.md', 'old')
    symlinkSync(join(root, 'docs'), join(root, 'notes'))

    await writeWorkspaceFile(root, 'notes/rate-limits.md', 'new')

    expect(read(join(root, 'docs', 'rate-limits.md'))).toBe('new')
    expect(lstatSync(join(root, 'notes')).isSymbolicLink()).toBe(true)
  })

  it('makes a file that went again, in its folder or at the root', async () => {
    mkdirSync(join(root, 'docs'))

    await writeWorkspaceFile(root, 'docs/new.md', '# New\n')
    await writeWorkspaceFile(root, 'TOP.md', 'top')

    expect(read(join(root, 'docs', 'new.md'))).toBe('# New\n')
    expect(read(join(root, 'TOP.md'))).toBe('top')
  })

  it('refuses a file whose folder isn’t there, or is a file', async () => {
    write('README.md', 'Hi')

    for (const path of ['gone/new.md', 'README.md/child']) {
      expect((await failure(writeWorkspaceFile(root, path, 'x'))).code, path).toBe(BridgeErrorCode.NotFound)
    }
    expect(existsSync(join(root, 'gone'))).toBe(false)
    expect(read(join(root, 'README.md'))).toBe('Hi')
  })

  it('refuses `..` and absolute paths, writing nothing outside the root', async () => {
    const paths = [
      '../secrets/token.txt',
      'docs/../../secrets/token.txt',
      join(outside, 'token.txt'),
      '../secrets/new.txt',
      join(outside, 'new.txt'),
    ]
    for (const path of paths) {
      expect((await failure(writeWorkspaceFile(root, path, 'pwned'))).code, path).toBe(BridgeErrorCode.OutsideWorkspace)
    }
    expect(read(join(outside, 'token.txt'))).toBe('hunter2')
    expect(readdirSync(outside)).toEqual(['token.txt'])
  })

  it('refuses a symlink out of the root, to a file or through a folder, writing nothing outside', async () => {
    symlinkSync(join(outside, 'token.txt'), join(root, 'token.txt'))
    symlinkSync(outside, join(root, 'vendor'))

    for (const path of ['token.txt', 'vendor/token.txt', 'vendor/new.txt']) {
      expect((await failure(writeWorkspaceFile(root, path, 'pwned'))).code, path).toBe(BridgeErrorCode.OutsideWorkspace)
    }
    expect(read(join(outside, 'token.txt'))).toBe('hunter2')
    expect(readdirSync(outside)).toEqual(['token.txt'])
  })

  it('refuses a symlink to nothing, never making the file it leads to', async () => {
    symlinkSync(join(outside, 'planted.txt'), join(root, 'planted.txt'))

    const refused = await failure(writeWorkspaceFile(root, 'planted.txt', 'pwned'))

    expect(refused.code).toBe(BridgeErrorCode.InvalidRequest)
    expect(refused.message).toBe('planted.txt is a link to nothing')
    expect(existsSync(join(outside, 'planted.txt'))).toBe(false)
  })

  it('refuses a folder, and text too large to save', async () => {
    mkdirSync(join(root, 'docs'))
    write('big.txt', 'small')

    const folderRefused = await failure(writeWorkspaceFile(root, 'docs', 'x'))
    expect(folderRefused).toMatchObject({ code: BridgeErrorCode.InvalidRequest, message: "docs isn't a file" })
    const tooLarge = await failure(writeWorkspaceFile(root, 'big.txt', 'é'.repeat(MAX_SAVE_BYTES / 2 + 1)))
    expect(tooLarge).toMatchObject({ code: BridgeErrorCode.InvalidRequest, message: 'big.txt is too large to save' })
    expect(read(join(root, 'big.txt'))).toBe('small')
  })

  it('says plainly when it may not write the file, or make it in its folder', async () => {
    write('locked.md', 'locked')
    chmodSync(join(root, 'locked.md'), 0o444)
    mkdirSync(join(root, 'sealed'))
    chmodSync(join(root, 'sealed'), 0o555)
    mkdirSync(join(root, 'hidden'))
    chmodSync(join(root, 'hidden'), 0o600)
    try {
      await expect(writeWorkspaceFile(root, 'locked.md', 'x')).rejects.toThrow(
        "you don't have permission to write locked.md",
      )
      await expect(writeWorkspaceFile(root, 'sealed/new.md', 'x')).rejects.toThrow(
        "you don't have permission to write sealed/new.md",
      )
      await expect(writeWorkspaceFile(root, 'hidden/new.md', 'x')).rejects.toThrow(
        "you don't have permission to write hidden/new.md",
      )
      expect(read(join(root, 'locked.md'))).toBe('locked')
    } finally {
      chmodSync(join(root, 'sealed'), 0o755)
      chmodSync(join(root, 'hidden'), 0o755)
    }
  })
})

describe('saveFailure', () => {
  const errno = (code: string): Error => Object.assign(new Error(`${code}: /private/tmp/x`), { code })

  it('says what went wrong with a save without the file’s whole path, and passes on anything else', () => {
    expect(saveFailure('a.md', errno('ENOENT'))).toMatchObject({ code: BridgeErrorCode.NotFound })
    for (const code of ['EEXIST', 'ELOOP', 'EISDIR']) {
      expect(saveFailure('a.md', errno(code)), code).toMatchObject({
        code: BridgeErrorCode.InvalidRequest,
        message: "a.md isn't a file",
      })
    }
    expect(saveFailure('a.md', errno('EPERM'))).toMatchObject({ message: "you don't have permission to write a.md" })
    expect(saveFailure('a.md', errno('EROFS'))).toMatchObject({ message: 'a.md is on a read-only disk' })
    const other = errno('ENOSPC')
    expect(saveFailure('a.md', other)).toBe(other)
    expect(saveFailure('a.md', 'not an error')).toBe('not an error')
  })
})

describe('writeTaskFile', () => {
  it('saves a file of the task’s workspace, and fails for a task that is gone', async () => {
    write('README.md', '# Acme API\n')

    await writeTaskFile(context, taskId, 'README.md', '# Acme API\n\nNow with docs.\n')

    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('# Acme API\n\nNow with docs.\n')
    expect((await failure(writeTaskFile(context, 'gone', 'README.md', 'x'))).code).toBe(BridgeErrorCode.NotFound)
  })
})
