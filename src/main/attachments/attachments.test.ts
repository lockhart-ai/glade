import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeErrorCode } from '../../shared/bridge'
import { AttachedFileKind, MAX_ATTACHED_FILE_BYTES, type AttachedFile } from '../../shared/attachedFiles'
import { MessageRole } from '../../shared/domain'
import { MAX_IMAGE_BYTES } from '../../shared/images'
import { GIF, PNG, WEBP } from '../../shared/test-images'
import { CommandFailure } from '../bridge/errors'
import { appendMessage } from '../db/repositories/messages'
import { appendQueuedMessage } from '../db/repositories/queued-messages'
import { setInputDraft } from '../db/repositories/input-drafts'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { standInForWorkspaceRoot } from '../files/files'
import { createGit, type Git } from '../git/git'
import { openTestRepos, TEST_GIT_RUN, type TestRepos } from '../git/test-repos'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import {
  attachedFileKindOf,
  attachedImagesOf,
  attachFile,
  deleteTaskAttachments,
  discardAttachedFile,
  excludeAttachments,
  KIND_HEAD_BYTES,
  type AttachmentsContext,
} from './attachments'

let repos: TestRepos
let root: string
let desktop: string
let database: TestDatabase
let taskId: string
let workspaceId: string
let git: Git
let warn: ReturnType<typeof vi.fn<Logger['warn']>>
let log: Logger
let context: AttachmentsContext

/** Makes a file on the made-up Desktop, as one dragged from Finder would be, and answers its path. */
function onDesktop(name: string, contents: string | Buffer = 'region,total\nnorth,120\n'): string {
  const path = join(desktop, name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, contents)
  return path
}

function inWorkspace(path: string): string {
  return join(root, path)
}

async function failure(promise: Promise<unknown>): Promise<CommandFailure> {
  try {
    await promise
  } catch (error) {
    if (error instanceof CommandFailure) return error
    throw error
  }
  throw new Error('It did not fail')
}

function excludeOf(repo: string): string {
  return readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')
}

beforeEach(() => {
  repos = openTestRepos()
  root = join(repos.root, 'acme-api')
  mkdirSync(root)
  desktop = join(repos.root, 'Desktop')
  mkdirSync(desktop)
  database = openTestDatabase()
  workspaceId = sampleWorkspace(database.db, root).id
  taskId = sampleTask(database.db, workspaceId).id
  git = createGit(TEST_GIT_RUN)
  warn = vi.fn<Logger['warn']>()
  log = { ...SILENT_LOGGER, warn }
  context = { db: database.db, emit: () => undefined, git, log }
})

afterEach(() => {
  database.close()
  repos.close()
})

describe('attachFile', () => {
  it('copies the file byte for byte into the task’s folder, under its own name, and answers with the copy', async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0xfe, 0x0a, 0x00])
    const source = onDesktop('retention policy.pdf', bytes)

    const file = await attachFile(context, taskId, source)

    expect(file).toEqual({
      name: 'retention policy.pdf',
      path: `.glade/attachments/${taskId}/retention policy.pdf`,
      size: bytes.length,
      kind: AttachedFileKind.Binary,
    })
    expect(readFileSync(inWorkspace(file.path))).toEqual(bytes)
    // The original stays where it was.
    expect(readFileSync(source)).toEqual(bytes)
  })

  it('gives a second file of the same name the next free name, and a third the one after', async () => {
    const first = await attachFile(context, taskId, onDesktop('sales.csv', 'a\n'))
    const second = await attachFile(context, taskId, onDesktop('q3/sales.csv', 'b\n'))
    const third = await attachFile(context, taskId, onDesktop('sales.csv', 'c\n'))

    expect([first.name, second.name, third.name]).toEqual(['sales.csv', 'sales (2).csv', 'sales (3).csv'])
    expect(readFileSync(inWorkspace(second.path), 'utf8')).toBe('b\n')
    expect(readFileSync(inWorkspace(third.path), 'utf8')).toBe('c\n')
  })

  it('takes a name freed by a file taken off since, and never writes over a file that took one meanwhile', async () => {
    await attachFile(context, taskId, onDesktop('notes.txt', 'one'))
    // Another file appears under the next name after the folder was read, as one attached at the same moment would.
    writeFileSync(inWorkspace(`.glade/attachments/${taskId}/notes (2).txt`), 'theirs')
    const next = await attachFile(context, taskId, onDesktop('notes.txt', 'two'))
    expect(next.name).toBe('notes (3).txt')
    expect(readFileSync(inWorkspace(`.glade/attachments/${taskId}/notes (2).txt`), 'utf8')).toBe('theirs')
  })

  it('keeps each task’s files in its own folder, so the same name in two tasks needs no new name', async () => {
    const other = sampleTask(database.db, workspaceId).id
    const mine = await attachFile(context, taskId, onDesktop('sales.csv'))
    const theirs = await attachFile(context, other, onDesktop('sales.csv'))
    expect(mine.name).toBe('sales.csv')
    expect(theirs).toMatchObject({ name: 'sales.csv', path: `.glade/attachments/${other}/sales.csv` })
  })

  it('copies a symlink as the file it leads to, under the link’s own name', async () => {
    const target = onDesktop('exports/2026-q3.csv', 'region,total\nsouth,80\n')
    symlinkSync(target, join(desktop, 'latest.csv'))

    const file = await attachFile(context, taskId, join(desktop, 'latest.csv'))

    expect(file).toMatchObject({ name: 'latest.csv', kind: AttachedFileKind.Text })
    expect(readFileSync(inWorkspace(file.path), 'utf8')).toBe('region,total\nsouth,80\n')
    expect(readdirSync(inWorkspace(`.glade/attachments/${taskId}`), { withFileTypes: true })[0]?.isFile()).toBe(true)
  })

  it('refuses a folder, saying so, and copies nothing', async () => {
    mkdirSync(join(desktop, 'reports'))
    const refused = await failure(attachFile(context, taskId, join(desktop, 'reports')))
    expect(refused.code).toBe(BridgeErrorCode.InvalidRequest)
    expect(refused.message).toBe('reports is a folder: only files can be attached for now.')
    expect(existsSync(inWorkspace(`.glade/attachments/${taskId}/reports`))).toBe(false)
  })

  it('refuses a file larger than the cap, saying how large it is and what the cap is', async () => {
    const source = onDesktop('huge.bin', '')
    truncateSync(source, MAX_ATTACHED_FILE_BYTES + 1)
    const refused = await failure(attachFile(context, taskId, source))
    expect(refused.code).toBe(BridgeErrorCode.InvalidRequest)
    expect(refused.message).toBe('huge.bin is too large to attach (200 MB): files can be up to 200 MB.')
    expect(existsSync(inWorkspace(`.glade/attachments/${taskId}/huge.bin`))).toBe(false)
  })

  it('takes a file of exactly the cap', async () => {
    const source = onDesktop('just-fits.bin', '')
    truncateSync(source, MAX_ATTACHED_FILE_BYTES)
    await expect(attachFile(context, taskId, source)).resolves.toMatchObject({ size: MAX_ATTACHED_FILE_BYTES })
  })

  it('refuses a path with nothing at it, or a link to nothing', async () => {
    expect((await failure(attachFile(context, taskId, join(desktop, 'gone.csv')))).message).toBe(
      'gone.csv isn’t there any more.',
    )
    symlinkSync(join(desktop, 'nowhere.csv'), join(desktop, 'broken.csv'))
    expect((await failure(attachFile(context, taskId, join(desktop, 'broken.csv')))).message).toBe(
      'broken.csv isn’t there any more.',
    )
    expect((await failure(attachFile(context, taskId, join(onDesktop('file.txt'), 'inside')))).message).toBe(
      'inside isn’t there any more.',
    )
  })

  it('refuses something that isn’t a file, such as a device', async () => {
    const refused = await failure(attachFile(context, taskId, '/dev/null'))
    expect(refused.message).toBe('null isn’t a file, so it can’t be attached.')
  })

  it('refuses a name longer than a file can have', async () => {
    const name = `${'a'.repeat(252)}.csv`
    // Too long for the disk to have made, so the name alone is what's checked: it never gets as far as the disk.
    const refused = await failure(attachFile(context, taskId, join(desktop, name)))
    expect(refused.message).toBe(`${name} can’t be attached: its name is too long.`)
  })

  it('passes on a failure it can’t say better, such as a folder it may not read', async () => {
    const locked = join(desktop, 'locked')
    mkdirSync(locked)
    onDesktop('locked/secret.csv')
    chmodSync(locked, 0o000)
    try {
      await expect(attachFile(context, taskId, join(locked, 'secret.csv'))).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  it('passes on a file it may not read, leaving no copy', async () => {
    const source = onDesktop('locked.csv')
    chmodSync(source, 0o000)
    try {
      await expect(attachFile(context, taskId, source)).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      chmodSync(source, 0o644)
    }
    expect(existsSync(inWorkspace(`.glade/attachments/${taskId}/locked.csv`))).toBe(false)
  })

  it('gives files of the same name attached at the same moment a name each, writing over neither', async () => {
    const sources = ['a', 'b', 'c', 'd'].map((folder) => onDesktop(`${folder}/sales.csv`, `${folder}\n`))
    const files = await Promise.all(sources.map((source) => attachFile(context, taskId, source)))
    expect(new Set(files.map(({ name }) => name))).toEqual(
      new Set(['sales.csv', 'sales (2).csv', 'sales (3).csv', 'sales (4).csv']),
    )
    expect(new Set(files.map(({ path }) => readFileSync(inWorkspace(path), 'utf8')))).toEqual(
      new Set(['a\n', 'b\n', 'c\n', 'd\n']),
    )
  })

  it('refuses a task that isn’t there', async () => {
    const refused = await failure(attachFile(context, 'no-such-task', onDesktop('sales.csv')))
    expect(refused.code).toBe(BridgeErrorCode.NotFound)
  })

  it('refuses to write through a .glade that leads outside the workspace', async () => {
    const elsewhere = join(repos.root, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, inWorkspace('.glade'))
    const refused = await failure(attachFile(context, taskId, onDesktop('sales.csv')))
    expect(refused.code).toBe(BridgeErrorCode.OutsideWorkspace)
    expect(existsSync(join(elsewhere, 'attachments', taskId, 'sales.csv'))).toBe(false)
    // #514, finding 7: the folders were made before the check, so empty ones were left outside the workspace.
    expect(readdirSync(elsewhere)).toEqual([])
  })

  // #514, finding 7: the agent can make any of these links in its workspace, and attaching runs outside its sandbox.
  it.each([
    ['.glade/attachments', 'a link out of the workspace'],
    ['.glade', 'a link to nothing, which making the folder would have followed'],
  ])('makes nothing outside the workspace when %s is %s', async (linked, what) => {
    const elsewhere = join(repos.root, 'elsewhere')
    mkdirSync(elsewhere)
    mkdirSync(inWorkspace('.glade'), { recursive: true })
    if (linked === '.glade') rmSync(inWorkspace('.glade'), { recursive: true })
    symlinkSync(what.includes('nothing') ? join(elsewhere, 'not-there') : elsewhere, inWorkspace(linked))

    const refused = await failure(attachFile(context, taskId, onDesktop('sales.csv')))

    expect(refused.code).toBe(BridgeErrorCode.OutsideWorkspace)
    expect(readdirSync(elsewhere)).toEqual([])
  })

  it('still attaches through a .glade that’s a link to a folder inside the workspace', async () => {
    mkdirSync(inWorkspace('scratch'))
    symlinkSync(inWorkspace('scratch'), inWorkspace('.glade'))

    const file = await attachFile(context, taskId, onDesktop('sales.csv'))

    expect(readFileSync(inWorkspace(`scratch/attachments/${taskId}/sales.csv`), 'utf8')).toContain('north,120')
    expect(file.path).toBe(`.glade/attachments/${taskId}/sales.csv`)
  })

  it('gives up on a name once the folder has too many copies of it', async () => {
    const folder = inWorkspace(`.glade/attachments/${taskId}`)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'a'), '')
    for (let copy = 2; copy <= 1000; copy += 1) writeFileSync(join(folder, `a (${String(copy)})`), '')
    const refused = await failure(attachFile(context, taskId, onDesktop('a')))
    expect(refused.message).toBe('a can’t be attached: there are too many files of that name already.')
  })

  it('copies into the folder a made-up root stands for, as the test modes’ seeds have it', async () => {
    standInForWorkspaceRoot('/code/made-up', root)
    const made = sampleTask(database.db, sampleWorkspace(database.db, '/code/made-up').id).id
    const file = await attachFile(context, made, onDesktop('sales.csv'))
    expect(existsSync(inWorkspace(file.path))).toBe(true)
  })

  it('tells text, images and anything else apart', async () => {
    const text = await attachFile(context, taskId, onDesktop('notes.md', '# Notes\n\nCafé ☕\n'))
    const image = await attachFile(context, taskId, onDesktop('chart.png', Buffer.from(PNG.data, 'base64')))
    const binary = await attachFile(
      context,
      taskId,
      onDesktop('data.parquet', Buffer.from([0x50, 0x41, 0x52, 0x31, 0])),
    )
    const empty = await attachFile(context, taskId, onDesktop('empty.txt', ''))
    expect([text.kind, image.kind, binary.kind, empty.kind]).toEqual([
      AttachedFileKind.Text,
      AttachedFileKind.Image,
      AttachedFileKind.Binary,
      AttachedFileKind.Text,
    ])
  })
})

describe('attachedFileKindOf', () => {
  it('calls an image by its extension, whatever its bytes', () => {
    for (const name of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.svg']) {
      expect(attachedFileKindOf(name, new Uint8Array([0]))).toBe(AttachedFileKind.Image)
    }
  })

  it('calls UTF-8 with no NUL text, even cut off mid-character at the end of what was read', () => {
    const cut = Buffer.from('é'.repeat(KIND_HEAD_BYTES), 'utf8').subarray(0, KIND_HEAD_BYTES - 1)
    expect(attachedFileKindOf('notes.txt', cut)).toBe(AttachedFileKind.Text)
    expect(attachedFileKindOf('Makefile', Buffer.from('all:\n\tnpm test\n'))).toBe(AttachedFileKind.Text)
  })

  it('calls anything with a NUL, or bytes that aren’t UTF-8 (a PDF’s, say), binary', () => {
    expect(attachedFileKindOf('a.txt', Buffer.from('a\u0000b'))).toBe(AttachedFileKind.Binary)
    expect(attachedFileKindOf('policy.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46, 0x0a, 0xe2, 0xe3, 0xcf, 0xd3]))).toBe(
      AttachedFileKind.Binary,
    )
  })
})

describe('keeping the attachments out of git', () => {
  it('adds the folder to the repository’s own exclude file once, and touches no file the workspace commits', async () => {
    const repo = repos.repo('acme-api', { '.gitignore': 'node_modules/\n', 'README.md': '# Acme API\n' })
    await attachFile(context, taskId, onDesktop('sales.csv'))
    await attachFile(context, taskId, onDesktop('sales.csv'))

    const exclude = excludeOf(repo)
    expect(exclude.match(/^\/\.glade\/attachments\/$/gm)).toHaveLength(1)
    expect(exclude).toContain('# Files attached to messages in Glade\n/.glade/attachments/\n')
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('node_modules/\n')
    // Git sees nothing new: the copies are ignored, and no committed file changed.
    expect(repos.sh('git status --porcelain', repo)).toBe('')
  })

  it('anchors the folder at the workspace’s place in the repository when the workspace is inside one', async () => {
    const repo = repos.repo('monorepo')
    const nested = join(repo, 'services', 'acme api [v2]')
    mkdirSync(nested, { recursive: true })
    const task = sampleTask(database.db, sampleWorkspace(database.db, nested).id).id
    await attachFile(context, task, onDesktop('sales.csv'))

    expect(excludeOf(repo)).toContain('/services/acme api \\[v2]/.glade/attachments/\n')
    expect(repos.sh('git status --porcelain', repo)).toBe('')
  })

  it('starts the exclude file when the repository has none, and keeps what it had on its own line', async () => {
    const repo = repos.repo('acme-api')
    rmSync(join(repo, '.git', 'info'), { recursive: true, force: true })
    await expect(excludeAttachments(git, repo)).resolves.toBe(true)
    expect(excludeOf(repo)).toBe('# Files attached to messages in Glade\n/.glade/attachments/\n')

    writeFileSync(join(repo, '.git', 'info', 'exclude'), '*.log')
    await expect(excludeAttachments(git, repo)).resolves.toBe(true)
    expect(excludeOf(repo)).toBe('*.log\n# Files attached to messages in Glade\n/.glade/attachments/\n')
    await expect(excludeAttachments(git, repo)).resolves.toBe(false)
  })

  it('does nothing for a workspace in no repository', async () => {
    await attachFile(context, taskId, onDesktop('sales.csv'))
    expect(existsSync(inWorkspace('.git'))).toBe(false)
    await expect(excludeAttachments(git, root)).resolves.toBe(false)
  })

  it('attaches the file anyway when the exclude file can’t be written, noting why', async () => {
    const repo = repos.repo('acme-api')
    rmSync(join(repo, '.git', 'info'), { recursive: true, force: true })
    // A folder where the exclude file goes: it can be neither read nor written.
    mkdirSync(join(repo, '.git', 'info', 'exclude'), { recursive: true })
    const file = await attachFile(context, taskId, onDesktop('sales.csv'))
    expect(existsSync(inWorkspace(file.path))).toBe(true)
    expect(warn).toHaveBeenCalledWith('couldn’t keep the attachments out of git', expect.objectContaining({ taskId }))
  })
})

// #514, finding 7: `ln -sf ~/.zshenv .git/info/exclude` in a sandboxed command (the sandbox lets it write there), and
// the next file you attach appended two lines to `~/.zshenv`, or made it.
describe('keeping the attachments out of git, when the agent has put a link in the way', () => {
  const LINES = '# Files attached to messages in Glade\n/.glade/attachments/\n'

  it('never appends to a file the exclude file is a link to, and attaches the file anyway', async () => {
    const repo = repos.repo('acme-api')
    const zshenv = join(repos.root, '.zshenv')
    writeFileSync(zshenv, 'export EDITOR=vim\n')
    rmSync(join(repo, '.git', 'info', 'exclude'), { force: true })
    symlinkSync(zshenv, join(repo, '.git', 'info', 'exclude'))

    await expect(excludeAttachments(git, repo)).rejects.toMatchObject({ code: 'ELOOP' })
    const file = await attachFile(context, taskId, onDesktop('sales.csv'))

    expect(readFileSync(zshenv, 'utf8')).toBe('export EDITOR=vim\n')
    expect(existsSync(inWorkspace(file.path))).toBe(true)
    expect(warn).toHaveBeenCalledWith('couldn’t keep the attachments out of git', expect.objectContaining({ taskId }))
  })

  it('never makes the file a link to nothing leads to', async () => {
    const repo = repos.repo('acme-api')
    const zshenv = join(repos.root, '.zshenv')
    rmSync(join(repo, '.git', 'info', 'exclude'), { force: true })
    symlinkSync(zshenv, join(repo, '.git', 'info', 'exclude'))

    await expect(excludeAttachments(git, repo)).rejects.toMatchObject({ code: 'ELOOP' })

    expect(existsSync(zshenv)).toBe(false)
  })

  it('never writes through an `info` folder that’s a link out of the repository', async () => {
    const repo = repos.repo('acme-api')
    const elsewhere = join(repos.root, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'exclude'), '*.log\n')
    rmSync(join(repo, '.git', 'info'), { recursive: true, force: true })
    symlinkSync(elsewhere, join(repo, '.git', 'info'))

    await expect(excludeAttachments(git, repo)).rejects.toThrow('leads outside the repository')

    expect(readFileSync(join(elsewhere, 'exclude'), 'utf8')).toBe('*.log\n')
    expect(readdirSync(elsewhere)).toEqual(['exclude'])
  })

  it('still writes through an `info` that’s a link to a folder inside the repository’s own', async () => {
    const repo = repos.repo('acme-api')
    rmSync(join(repo, '.git', 'info'), { recursive: true, force: true })
    mkdirSync(join(repo, '.git', 'info-kept'))
    symlinkSync(join(repo, '.git', 'info-kept'), join(repo, '.git', 'info'))

    await expect(excludeAttachments(git, repo)).resolves.toBe(true)

    expect(readFileSync(join(repo, '.git', 'info-kept', 'exclude'), 'utf8')).toBe(LINES)
  })
})

describe('discardAttachedFile', () => {
  it('deletes the copy of a file taken off the draft before it was sent', async () => {
    const file = await attachFile(context, taskId, onDesktop('sales.csv'))
    setInputDraft(database.db, { taskId, text: '', files: [file] })
    await discardAttachedFile(context, taskId, file.path)
    expect(existsSync(inWorkspace(file.path))).toBe(false)
    // Gone already: nothing to do.
    await expect(discardAttachedFile(context, taskId, file.path)).resolves.toBeUndefined()
  })

  it('keeps a file a sent or queued message has', async () => {
    const sent = await attachFile(context, taskId, onDesktop('sent.csv'))
    const queued = await attachFile(context, taskId, onDesktop('queued.csv'))
    appendMessage(database.db, { taskId, role: MessageRole.User, body: '', turn: 1, files: [sent] })
    appendQueuedMessage(database.db, { taskId, body: '', files: [queued] })
    await discardAttachedFile(context, taskId, sent.path)
    await discardAttachedFile(context, taskId, queued.path)
    expect(existsSync(inWorkspace(sent.path))).toBe(true)
    expect(existsSync(inWorkspace(queued.path))).toBe(true)
  })

  it('refuses a path that isn’t one of the task’s attached files, deleting nothing', async () => {
    writeFileSync(inWorkspace('README.md'), '# Acme API\n')
    for (const path of ['README.md', `.glade/attachments/${taskId}/../../../README.md`, '.glade/attachments/other/a']) {
      expect((await failure(discardAttachedFile(context, taskId, path))).code).toBe(BridgeErrorCode.InvalidRequest)
    }
    expect(existsSync(inWorkspace('README.md'))).toBe(true)
  })

  it('never deletes through a folder swapped for a link out of the workspace', async () => {
    const file = await attachFile(context, taskId, onDesktop('sales.csv'))
    const elsewhere = join(repos.root, 'elsewhere')
    mkdirSync(join(elsewhere, 'attachments', taskId), { recursive: true })
    writeFileSync(join(elsewhere, 'attachments', taskId, 'sales.csv'), 'theirs\n')
    rmSync(inWorkspace('.glade'), { recursive: true })
    symlinkSync(elsewhere, inWorkspace('.glade'))

    await expect(discardAttachedFile(context, taskId, file.path)).resolves.toBeUndefined()

    expect(readFileSync(join(elsewhere, 'attachments', taskId, 'sales.csv'), 'utf8')).toBe('theirs\n')
  })

  it('passes on a failure other than the file being gone', async () => {
    const file = await attachFile(context, taskId, onDesktop('sales.csv'))
    rmSync(inWorkspace(file.path))
    mkdirSync(inWorkspace(file.path))
    writeFileSync(join(inWorkspace(file.path), 'inside'), '')
    // Unlinking a non-empty directory fails with EPERM on macOS and EISDIR on Linux; either way it isn't ENOENT
    // ("the file being gone"), which is the one failure discardAttachedFile swallows.
    await expect(discardAttachedFile(context, taskId, file.path)).rejects.not.toMatchObject({ code: 'ENOENT' })
  })
})

describe('deleteTaskAttachments', () => {
  it('deletes the task’s folder and everything in it, leaving other tasks’ and the rest of .glade', async () => {
    const other = sampleTask(database.db, workspaceId).id
    await attachFile(context, taskId, onDesktop('sales.csv'))
    await attachFile(context, other, onDesktop('sales.csv'))
    mkdirSync(inWorkspace('.glade/tasks/rate-limits'), { recursive: true })

    deleteTaskAttachments(root, taskId, log)

    expect(existsSync(inWorkspace(`.glade/attachments/${taskId}`))).toBe(false)
    expect(existsSync(inWorkspace(`.glade/attachments/${other}/sales.csv`))).toBe(true)
    expect(existsSync(inWorkspace('.glade/tasks/rate-limits'))).toBe(true)
  })

  it('does nothing for a task that never had any, or an id that isn’t one folder', () => {
    deleteTaskAttachments(root, taskId, log)
    mkdirSync(inWorkspace('.glade/attachments'), { recursive: true })
    deleteTaskAttachments(root, '..', log)
    expect(existsSync(inWorkspace('.glade/attachments'))).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('never deletes through a folder swapped for a link out of the workspace', () => {
    const elsewhere = join(repos.root, 'elsewhere')
    mkdirSync(join(elsewhere, 'attachments', taskId), { recursive: true })
    writeFileSync(join(elsewhere, 'attachments', taskId, 'taxes.txt'), 'theirs\n')
    symlinkSync(elsewhere, inWorkspace('.glade'))

    deleteTaskAttachments(root, taskId, log)

    expect(readFileSync(join(elsewhere, 'attachments', taskId, 'taxes.txt'), 'utf8')).toBe('theirs\n')
    expect(warn).not.toHaveBeenCalled()
  })

  it('leaves a folder it can’t delete, noting why', async () => {
    await attachFile(context, taskId, onDesktop('sales.csv'))
    const attachments = inWorkspace('.glade/attachments')
    chmodSync(attachments, 0o500)
    try {
      deleteTaskAttachments(root, taskId, log)
      expect(warn).toHaveBeenCalledWith(
        'couldn’t delete the task’s attached files',
        expect.objectContaining({ taskId }),
      )
    } finally {
      chmodSync(attachments, 0o755)
    }
  })
})

describe('attachedImagesOf', () => {
  function attached(name: string, bytes: Buffer, kind = AttachedFileKind.Image): AttachedFile {
    const path = `.glade/attachments/${taskId}/${name}`
    mkdirSync(inWorkspace(`.glade/attachments/${taskId}`), { recursive: true })
    writeFileSync(inWorkspace(path), bytes)
    return { name, path, size: bytes.length, kind }
  }

  it('reads each PNG, JPEG, GIF or WebP attached as an image the agent takes, in order', () => {
    const files = [
      attached('chart.png', Buffer.from(PNG.data, 'base64')),
      attached('notes.txt', Buffer.from('hello'), AttachedFileKind.Text),
      attached('anim.GIF', Buffer.from(GIF.data, 'base64')),
      attached('photo.webp', Buffer.from(WEBP.data, 'base64')),
    ]
    expect(attachedImagesOf(root, files)).toEqual([PNG, GIF, WEBP])
  })

  it('leaves out an SVG, a file gone or swapped for a link since, one too large, or one that isn’t what it says', () => {
    const png = Buffer.from(PNG.data, 'base64')
    const svg = attached('logo.svg', Buffer.from('<svg/>'))
    const gone = attached('gone.png', png)
    rmSync(inWorkspace(gone.path))
    const linked = attached('linked.png', png)
    rmSync(inWorkspace(linked.path))
    symlinkSync(inWorkspace(svg.path), inWorkspace(linked.path))
    const large = attached('large.png', Buffer.concat([png, Buffer.alloc(MAX_IMAGE_BYTES)]))
    const fake = attached('fake.png', Buffer.from('not a png'))
    const folder = attached('folder.png', png)
    rmSync(inWorkspace(folder.path))
    mkdirSync(inWorkspace(folder.path))
    expect(attachedImagesOf(root, [svg, gone, linked, large, fake, folder])).toEqual([])
  })

  // #514, finding 7: a queued message's image is read when the message is delivered, outside the sandbox. The copy's
  // own name was never followed as a link, but a folder above it was.
  it('reads nothing through a folder swapped for a link out of the workspace while the message waited', () => {
    const png = Buffer.from(PNG.data, 'base64')
    const chart = attached('chart.png', png)
    expect(attachedImagesOf(root, [chart])).toEqual([PNG])
    const elsewhere = join(repos.root, 'Pictures')

    for (const swapped of [`.glade/attachments/${taskId}`, '.glade/attachments', '.glade']) {
      // The same name, where the link leads: an image of yours the agent was never given.
      const theirs = join(elsewhere, inWorkspace(chart.path).slice(inWorkspace(swapped).length))
      mkdirSync(join(theirs, '..'), { recursive: true })
      writeFileSync(theirs, png)
      rmSync(inWorkspace(swapped), { recursive: true })
      symlinkSync(elsewhere, inWorkspace(swapped))

      expect(attachedImagesOf(root, [chart])).toEqual([])

      rmSync(inWorkspace(swapped))
      rmSync(elsewhere, { recursive: true })
      attached('chart.png', png)
    }
    // Put back as it was, it reads again.
    expect(attachedImagesOf(root, [chart])).toEqual([PNG])
  })
})
