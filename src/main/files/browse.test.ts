import { chmodSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FolderEntryKind, MAX_SEARCH_RESULTS, type FolderEntry } from '../../shared/browse'
import { BridgeErrorCode } from '../../shared/bridge'
import { SHELL_GIT_ENV } from '../agent/scripted-shell'
import { execGit, type GitRun } from '../git/git'
import { openTestRepos, type TestRepos } from '../git/test-repos'
import { createWorkspaceGit, listWorkspaceFolder, searchWorkspaceFiles, type WorkspaceGit } from './browse'

let repos: TestRepos
let git: WorkspaceGit

beforeEach(() => {
  repos = openTestRepos()
  // Git as Glade runs it, with none of the machine's config or global excludes.
  git = createWorkspaceGit(
    execGit({ ...process.env, ...SHELL_GIT_ENV, HOME: repos.root, XDG_CONFIG_HOME: join(repos.root, 'no-config') }),
  )
})

afterEach(() => {
  repos.close()
})

/** A folder's entries as `d name` (a folder) or `f name` (a file), in the tree's order. */
function shown(entries: readonly FolderEntry[] | null): string[] | null {
  return entries?.map(({ kind, name }) => `${kind === FolderEntryKind.Folder ? 'd' : 'f'} ${name}`) ?? null
}

/** Makes files (and their folders) under `root`, each with a line of made-up text. */
function files(root: string, paths: readonly string[]): void {
  for (const path of paths) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), `${path}\n`)
  }
}

describe('listWorkspaceFolder', () => {
  it('lists a folder a level at a time: folders first, then files, each by name, numbers by their value', async () => {
    const root = join(repos.root, 'notes')
    files(root, ['b.txt', 'A.md', 'file10.txt', 'file2.txt', 'zeta/z.md', 'alpha/beta/deep.md', 'Alpha2/x.md'])

    expect(shown(await listWorkspaceFolder(root, '', git))).toEqual([
      'd alpha',
      'd Alpha2',
      'd zeta',
      'f A.md',
      'f b.txt',
      'f file2.txt',
      'f file10.txt',
    ])
    expect(await listWorkspaceFolder(root, 'alpha', git)).toEqual([
      { name: 'beta', path: 'alpha/beta', kind: FolderEntryKind.Folder },
    ])
    expect(await listWorkspaceFolder(root, 'alpha/beta', git)).toEqual([
      { name: 'deep.md', path: 'alpha/beta/deep.md', kind: FolderEntryKind.File, size: 19 },
    ])
  })

  it('gives each file its size in bytes, a symlink its target’s, and a folder none', async () => {
    const root = join(repos.root, 'sized')
    mkdirSync(join(root, 'api'), { recursive: true })
    writeFileSync(join(root, 'empty.txt'), '')
    writeFileSync(join(root, 'logo.png'), Buffer.alloc(1_400_000))
    writeFileSync(join(root, 'naïve.md'), 'é\n')
    symlinkSync(join(root, 'logo.png'), join(root, 'alias.png'))
    symlinkSync(join(root, 'api'), join(root, 'linked'))

    expect(await listWorkspaceFolder(root, '', git)).toEqual([
      { name: 'api', path: 'api', kind: FolderEntryKind.Folder },
      { name: 'linked', path: 'linked', kind: FolderEntryKind.Folder },
      { name: 'alias.png', path: 'alias.png', kind: FolderEntryKind.File, size: 1_400_000 },
      { name: 'empty.txt', path: 'empty.txt', kind: FolderEntryKind.File, size: 0 },
      { name: 'logo.png', path: 'logo.png', kind: FolderEntryKind.File, size: 1_400_000 },
      // Bytes, not characters.
      { name: 'naïve.md', path: 'naïve.md', kind: FolderEntryKind.File, size: 3 },
    ])
  })

  it('lists a file that goes between the listing and its stat without a size, and the rest as they are', async () => {
    const root = join(repos.root, 'fleeting')
    files(root, ['build.tmp', 'kept.txt', 'src/main.py'])
    // Git is asked about the names once the folder has been read and before any file is looked at: the file goes then.
    const vanishing: WorkspaceGit = {
      ignored: async (dir, names) => {
        unlinkSync(join(root, 'build.tmp'))
        return git.ignored(dir, names)
      },
      files: (dir) => git.files(dir),
    }

    expect(await listWorkspaceFolder(root, '', vanishing)).toEqual([
      { name: 'src', path: 'src', kind: FolderEntryKind.Folder },
      { name: 'build.tmp', path: 'build.tmp', kind: FolderEntryKind.File },
      { name: 'kept.txt', path: 'kept.txt', kind: FolderEntryKind.File, size: 9 },
    ])
    // Listed again, as the folder's watcher has it listed, it's gone.
    expect(shown(await listWorkspaceFolder(root, '', git))).toEqual(['d src', 'f kept.txt'])
  })

  it('hides .git and .glade at any depth, outside a repository too, and nothing else there', async () => {
    const root = join(repos.root, 'plain')
    files(root, ['.glade/state.json', 'vendor/.git', 'vendor/lib.js', 'node_modules/left-pad/index.js', 'debug.log'])

    expect(shown(await listWorkspaceFolder(root, '', git))).toEqual(['d node_modules', 'd vendor', 'f debug.log'])
    expect(shown(await listWorkspaceFolder(root, 'vendor', git))).toEqual(['f lib.js'])
    // Asked for by path, a hidden folder isn't listed either.
    expect(await listWorkspaceFolder(root, '.glade', git)).toBeNull()
    expect(await listWorkspaceFolder(root, 'vendor/.git', git)).toBeNull()
  })

  it('hides what git ignores in a repository, by any .gitignore, but never a file it tracks', async () => {
    const root = repos.repo('acme-api', {
      '.gitignore': 'node_modules/\n*.log\nbuild\n',
      'api/.gitignore': 'local.py\n',
      'api/views.py': '# Views\n',
      'README.md': '# Acme API\n',
    })
    files(root, [
      'node_modules/left-pad/index.js',
      'build/out.js',
      'server.log',
      'api/local.py',
      'api/routes.py',
      'notes.txt',
      '.glade/state.json',
    ])
    writeFileSync(join(root, 'kept.log'), 'tracked anyway\n')
    repos.sh('git add -f kept.log && git commit -q -m "Keep a log"', root)

    expect(shown(await listWorkspaceFolder(root, '', git))).toEqual([
      'd api',
      'f .gitignore',
      'f kept.log',
      'f notes.txt',
      'f README.md',
    ])
    expect(shown(await listWorkspaceFolder(root, 'api', git))).toEqual(['f .gitignore', 'f routes.py', 'f views.py'])
  })

  it('follows the ignore rules of the repository a workspace sits inside', async () => {
    const top = repos.repo('monorepo', { '.gitignore': '*.tmp\n', 'services/api/app.py': 'app = 1\n' })
    const root = join(top, 'services', 'api')
    files(root, ['scratch.tmp', 'tests/test_app.py'])

    expect(shown(await listWorkspaceFolder(root, '', git))).toEqual(['d tests', 'f app.py'])
  })

  it('lists a symlink only when it leads to a file or folder inside the root', async () => {
    const root = join(repos.root, 'linked')
    const outside = join(repos.root, 'secrets')
    files(root, ['docs/guide.md', 'real.txt'])
    files(outside, ['token.txt'])
    symlinkSync(join(root, 'real.txt'), join(root, 'alias.txt'))
    symlinkSync(join(root, 'docs'), join(root, 'manual'))
    symlinkSync(join(outside, 'token.txt'), join(root, 'token.txt'))
    symlinkSync(outside, join(root, 'secrets'))
    symlinkSync(join(root, 'gone.txt'), join(root, 'dangling.txt'))

    expect(shown(await listWorkspaceFolder(root, '', git))).toEqual(['d docs', 'd manual', 'f alias.txt', 'f real.txt'])
    // A folder inside the root that a symlink leads to lists under the link's path.
    expect(await listWorkspaceFolder(root, 'manual', git)).toEqual([
      { name: 'guide.md', path: 'manual/guide.md', kind: FolderEntryKind.File, size: 14 },
    ])
    // Never through one that leads out.
    await expect(listWorkspaceFolder(root, 'secrets', git)).rejects.toMatchObject({
      code: BridgeErrorCode.OutsideWorkspace,
    })
  })

  it('answers null for a folder that isn’t there, or a file, and an empty list for an empty folder', async () => {
    const root = join(repos.root, 'sparse')
    files(root, ['README.md'])
    mkdirSync(join(root, 'empty'))
    const asked = {
      ignored: vi.fn((dir: string, names: readonly string[]) => git.ignored(dir, names)),
      files: vi.fn((dir: string) => git.files(dir)),
    }

    expect(await listWorkspaceFolder(root, 'missing', asked)).toBeNull()
    expect(await listWorkspaceFolder(root, 'README.md', asked)).toBeNull()
    expect(await listWorkspaceFolder(join(repos.root, 'nowhere'), '', asked)).toBeNull()
    expect(await listWorkspaceFolder(root, 'empty', asked)).toEqual([])
    // Nothing to ask git about in an empty folder.
    expect(asked.ignored).not.toHaveBeenCalled()
  })
})

describe('createWorkspaceGit', () => {
  it('asks about every name as it is, however odd, and hides only what git says it ignores', async () => {
    const root = repos.repo('odd-names', { '.gitignore': '*.log\n', 'keep.txt': 'x\n' })
    const odd = ['-dash.log', 'quote".log', 'new\nline.log', 'ünïcode.log', 'back\\slash.log', 'tab\there.txt']
    for (const name of odd) writeFileSync(join(root, name), 'x\n')

    const ignored = await git.ignored(root, [...odd, 'keep.txt'])

    expect([...ignored].sort()).toEqual(odd.filter((name) => name.endsWith('.log')).sort())
  })

  it('hides nothing when git fails', async () => {
    const run: GitRun = () => Promise.resolve({ ok: false, stdout: Buffer.from('a.log\0'), truncated: false })
    expect(await createWorkspaceGit(run).ignored('/code/api', ['a.log'])).toEqual(new Set())
  })

  it('lists no files outside a repository', async () => {
    const root = join(repos.root, 'plain')
    files(root, ['a.md'])
    expect(await git.files(root)).toBeNull()
    expect(await git.ignored(root, ['a.md'])).toEqual(new Set())
  })
})

describe('searchWorkspaceFiles', () => {
  it('finds a repository’s files by name or path, best first, hiding what the tree hides', async () => {
    const root = repos.repo('acme-api', {
      '.gitignore': 'build/\n',
      'api/throttles.py': 'x\n',
      'api/tests/test_throttles.py': 'x\n',
      'api/migrations/0004_throttle_scopes.py': 'x\n',
      'docs/guides/throttle-scopes.md': 'x\n',
      'throttle/README.md': 'x\n',
      'gone/throttle.py': 'x\n',
    })
    // Untracked files count; ignored ones and Glade's own don't, nor a file git tracks that's gone, nor another
    // repository inside the workspace (git lists it as a folder).
    files(root, ['scripts/Throttle_report.sh', 'build/throttle.js', '.glade/throttle.json'])
    unlinkSync(join(root, 'gone/throttle.py'))
    repos.repo('acme-api/throttle-vendored', { 'lib.py': 'x\n' })

    expect(await searchWorkspaceFiles(root, '  THROTTLE ', git)).toEqual({
      paths: [
        // Names that start with it…
        'api/throttles.py',
        'docs/guides/throttle-scopes.md',
        'scripts/Throttle_report.sh',
        // …then names that hold it…
        'api/migrations/0004_throttle_scopes.py',
        'api/tests/test_throttles.py',
        // …then paths that do.
        'throttle/README.md',
      ],
      more: 0,
      // Each one's size in bytes.
      sizes: {
        'api/throttles.py': 2,
        'docs/guides/throttle-scopes.md': 2,
        'scripts/Throttle_report.sh': 27,
        'api/migrations/0004_throttle_scopes.py': 2,
        'api/tests/test_throttles.py': 2,
        'throttle/README.md': 2,
      },
    })
    expect(await searchWorkspaceFiles(root, 'api/tests/', git)).toEqual({
      paths: ['api/tests/test_throttles.py'],
      more: 0,
      sizes: { 'api/tests/test_throttles.py': 2 },
    })
    expect(await searchWorkspaceFiles(root, '   ', git)).toEqual({ paths: [], more: 0, sizes: {} })
  })

  it('looks through every file outside a repository, without following a symlinked folder or leaving the root', async () => {
    const root = join(repos.root, 'plain')
    const outside = join(repos.root, 'secrets')
    files(root, ['notes/plan.md', 'plan-b.md', '.glade/plan.json', 'vendor/.git/plan', 'deep/er/still/plan.txt'])
    files(outside, ['plan-secret.md'])
    symlinkSync(join(root, 'notes'), join(root, 'plans-link'))
    symlinkSync(join(root, 'plan-b.md'), join(root, 'plan-alias.md'))
    symlinkSync(join(outside, 'plan-secret.md'), join(root, 'plan-secret.md'))

    expect(await searchWorkspaceFiles(root, 'plan', git)).toEqual({
      paths: ['deep/er/still/plan.txt', 'notes/plan.md', 'plan-alias.md', 'plan-b.md'],
      more: 0,
      // A symlink's size is its target's.
      sizes: { 'deep/er/still/plan.txt': 23, 'notes/plan.md': 14, 'plan-alias.md': 10, 'plan-b.md': 10 },
    })
  })

  it('answers with the first 200 matches and how many more', async () => {
    const root = repos.repo('big', { 'README.md': 'x\n' })
    const many = Array.from({ length: MAX_SEARCH_RESULTS + 37 }, (_, index) => `tests/test_${String(index)}.py`)
    files(root, many)

    const found = await searchWorkspaceFiles(root, 'test_', git)

    expect(found.paths).toHaveLength(MAX_SEARCH_RESULTS)
    expect(found.paths.slice(0, 3)).toEqual(['tests/test_0.py', 'tests/test_1.py', 'tests/test_2.py'])
    expect(found.more).toBe(37)
  })

  it('stops looking past its limit outside a repository', async () => {
    const root = join(repos.root, 'plain')
    files(root, ['a/one.md', 'b/two.md', 'c/three.md', 'd/four.md'])

    const found = await searchWorkspaceFiles(root, '.md', git, 2)

    expect(found.paths).toHaveLength(2)
    expect(found.more).toBe(0)
  })

  it('passes over a folder it may not read outside a repository', async () => {
    const root = join(repos.root, 'plain')
    files(root, ['open/plan.md', 'locked/plan.md'])
    chmodSync(join(root, 'locked'), 0o000)
    try {
      expect(await searchWorkspaceFiles(root, 'plan', git)).toEqual({
        paths: ['open/plan.md'],
        more: 0,
        sizes: { 'open/plan.md': 13 },
      })
    } finally {
      chmodSync(join(root, 'locked'), 0o755)
    }
  })

  it('fails when the workspace’s folder isn’t there', async () => {
    await expect(searchWorkspaceFiles(join(repos.root, 'nowhere'), 'a', git)).rejects.toMatchObject({
      code: BridgeErrorCode.NotFound,
    })
  })
})
