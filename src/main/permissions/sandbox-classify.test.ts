// Which calls ask with the agent sandbox on (#445): crossing its bounds asks in either mode, however the path is
// spelled; credential paths are refused; running outside it always asks (or is refused, once it couldn't start); a
// write Claude Code's own checks held back asks; and reads outside the home folder go ahead.
import { describe, expect, it } from 'vitest'
import { PermissionMode, type ToolInput } from '../../shared/domain'
import { GLADE_SERVER } from '../agent/glade-tools'
import { FolderAccess } from '../../shared/sandbox'
import { NO_GRANTS, type SandboxGrants } from '../agent/sandbox'
import type { PathFs } from './canonical-path'
import { PermissionVerdict } from './classify'
import {
  BOUNDED_TOOLS,
  callStanding,
  isSandboxOverride,
  isUnboundedRule,
  isWriteTool,
  sandboxBounds,
  sandboxCrossing,
  SandboxCrossing,
  toolCallVerdict,
  type SandboxBounds,
  type ToolCallVerdict,
} from './sandbox-classify'

const HOME = '/Users/me'
const ROOT = '/Users/me/src/acme-api'

const GRANTS: SandboxGrants = {
  folders: [
    { path: '/Users/me/notes', access: FolderAccess.Read },
    { path: '/Users/me/src/shared-lib/', access: FolderAccess.ReadWrite },
  ],
  domains: ['registry.npmjs.org', '*.acme.dev'],
}

/** A file system where nothing is a link: every path is where it says, but for the ones given. */
function fsWith(real: Readonly<Record<string, string>> = {}, links: Readonly<Record<string, string>> = {}): PathFs {
  return {
    realpath: (path) => real[path] ?? null,
    readlink: (path) => links[path] ?? null,
  }
}

interface BoundsOverrides {
  readonly root?: string
  readonly grants?: SandboxGrants
  readonly fs?: PathFs
  readonly denied?: readonly string[]
  readonly unsandboxed?: (command: string) => boolean
}

function bounds(overrides: BoundsOverrides = {}): SandboxBounds {
  return sandboxBounds({
    root: overrides.root ?? ROOT,
    home: HOME,
    grants: overrides.grants ?? GRANTS,
    fs: overrides.fs ?? fsWith(),
    ...(overrides.denied === undefined ? {} : { denied: overrides.denied }),
    ...(overrides.unsandboxed === undefined ? {} : { unsandboxed: overrides.unsandboxed }),
  })
}

function crossing(toolName: string, input: ToolInput, within: SandboxBounds = bounds()): SandboxCrossing {
  return sandboxCrossing({ toolName, input }, within)
}

describe('sandboxBounds', () => {
  it('holds the folders by where they really are, and leaves out a grant the sandbox can’t take', () => {
    const made = sandboxBounds({
      root: '/tmp/acme-api/',
      home: HOME,
      grants: {
        folders: [
          { path: '/Users/me/Notes', access: FolderAccess.Read },
          { path: '/Users/me/x/../../..', access: FolderAccess.ReadWrite },
          { path: '/Users/me/a*', access: FolderAccess.Read },
        ],
        domains: ['registry.npmjs.org', '*'],
      },
      fs: fsWith({ '/tmp/acme-api': '/private/tmp/acme-api' }),
    })

    expect(made).toMatchObject({
      root: '/tmp/acme-api',
      home: HOME,
      readable: ['/private/tmp/acme-api', '/users/me/notes'],
      writable: ['/private/tmp/acme-api'],
      bounded: ['/users/me', '/users', '/volumes', '/system/volumes'],
      domains: ['registry.npmjs.org'],
    })
    expect(made.credentials).toContain('/users/me/.ssh')
    expect(made.credentials).toContain('/users/me/.docker/config.json')
  })

  it('uses the real file system unless given another', () => {
    expect(sandboxBounds({ root: '/', home: '/', grants: NO_GRANTS }).readable).toEqual(['/'])
  })
})

describe('a granted folder is the path that was granted', () => {
  const NOTES = '/Users/me/notes'
  const SHARED = '/Users/me/src/shared-lib'
  // Each granted folder has been swapped for a link since: to Documents, and to the home folder's Library.
  const swapped = fsWith({ [NOTES]: '/Users/me/Documents', [SHARED]: '/Users/me/Library' })

  it('never follows a link in a kept grant: what it leads to now was never granted', () => {
    const made = bounds({ fs: swapped })

    // Before #510's review, the bounds named where each link led, and Documents and Library opened.
    expect(made.readable).toEqual(['/users/me/src/acme-api', '/users/me/notes', '/users/me/src/shared-lib'])
    expect(made.writable).toEqual(['/users/me/src/acme-api', '/users/me/src/shared-lib'])
    for (const path of ['/Users/me/Documents/taxes.txt', `${NOTES}/taxes.txt`]) {
      expect(crossing('Read', { file_path: path }, made)).toBe(SandboxCrossing.Boundary)
    }
    for (const path of ['/Users/me/Library/LaunchAgents/x.plist', `${SHARED}/LaunchAgents/x.plist`]) {
      expect(crossing('Write', { file_path: path }, made)).toBe(SandboxCrossing.Boundary)
    }
  })

  it('still takes a call’s own path for where it really is', () => {
    // A link in the root to the granted folder leads into it; the grants are as they were kept.
    const linked = bounds({ fs: fsWith({ [`${ROOT}/notes-link`]: NOTES }) })

    expect(crossing('Read', { file_path: 'notes-link/today.md' }, linked)).toBe(SandboxCrossing.None)
    expect(crossing('Write', { file_path: 'notes-link/today.md' }, linked)).toBe(SandboxCrossing.Boundary)
  })

  it('finds a kept grant in whatever case, Unicode form or volume alias it was kept', () => {
    const kept = bounds({
      grants: {
        folders: [
          { path: '/System/Volumes/Data/Users/me/Notes', access: FolderAccess.Read },
          { path: '/Users/me/Cafe\u0301', access: FolderAccess.ReadWrite },
        ],
        domains: [],
      },
    })

    expect(kept.readable).toEqual(['/users/me/src/acme-api', '/users/me/notes', '/users/me/caf\u00e9'])
    expect(crossing('Read', { file_path: '/users/ME/notes/a.md' }, kept)).toBe(SandboxCrossing.None)
    expect(crossing('Write', { file_path: '/Users/me/Caf\u00e9/menu.md' }, kept)).toBe(SandboxCrossing.None)
  })
})

describe('a single file’s grant', () => {
  const files: SandboxGrants = {
    folders: [
      { path: '/Users/me/todo.txt', access: FolderAccess.Read, file: true },
      { path: '/Users/me/notes.txt', access: FolderAccess.ReadWrite, file: true },
    ],
    domains: [],
  }
  const within = bounds({ grants: files })

  it('is kept apart from the folders: that path alone', () => {
    expect(within.readable).toEqual(['/users/me/src/acme-api'])
    expect(within.writable).toEqual(['/users/me/src/acme-api'])
    expect(within.readableFiles).toEqual(['/users/me/todo.txt', '/users/me/notes.txt'])
    expect(within.writableFiles).toEqual(['/users/me/notes.txt'])
  })

  it('lets its file be read, and written when it’s read-write', () => {
    expect(crossing('Read', { file_path: '~/todo.txt' }, within)).toBe(SandboxCrossing.None)
    expect(crossing('Read', { file_path: '/Users/me/notes.txt' }, within)).toBe(SandboxCrossing.None)
    expect(crossing('Edit', { file_path: '/Users/ME/Notes.txt' }, within)).toBe(SandboxCrossing.None)
    expect(crossing('Write', { file_path: '~/todo.txt' }, within)).toBe(SandboxCrossing.Boundary)
  })

  it.each([
    ['its folder', '/Users/me'],
    ['a file beside it', '/Users/me/.vimrc'],
    ['a file whose name starts with its name', '/Users/me/notes.txt.bak'],
    ['another whose name starts with its name', '/Users/me/notes.txt2'],
    ['a path under it, as if it were a folder', '/Users/me/notes.txt/inside.md'],
    ['a folder beside it', '/Users/me/Documents/taxes.txt'],
  ])('opens nothing else: %s asks, to read or to write', (_what, path) => {
    expect(crossing('Read', { file_path: path }, within)).toBe(SandboxCrossing.Boundary)
    expect(crossing('LS', { path }, within)).toBe(SandboxCrossing.Boundary)
    expect(crossing('Write', { file_path: path }, within)).toBe(SandboxCrossing.Boundary)
  })

  it('opens nothing through a link put where the file was, and never a credential file', () => {
    const swapped = bounds({ grants: files, fs: fsWith({ '/Users/me/notes.txt': '/Users/me/Documents/taxes.txt' }) })
    expect(crossing('Read', { file_path: '/Users/me/notes.txt' }, swapped)).toBe(SandboxCrossing.Boundary)
    expect(crossing('Write', { file_path: '/Users/me/notes.txt' }, swapped)).toBe(SandboxCrossing.Boundary)

    const credential: SandboxGrants = {
      folders: [{ path: '/Users/me/.netrc', access: FolderAccess.ReadWrite, file: true }],
      domains: [],
    }
    expect(crossing('Read', { file_path: '~/.netrc' }, bounds({ grants: credential }))).toBe(SandboxCrossing.Credential)
  })

  it('holds a write to a granted file that runs code back, as inside any granted folder', () => {
    const zshrc: SandboxGrants = {
      folders: [{ path: '/Users/me/.zshrc', access: FolderAccess.ReadWrite, file: true }],
      domains: [],
    }
    expect(crossing('Edit', { file_path: '~/.zshrc' }, bounds({ grants: zshrc }))).toBe(SandboxCrossing.Protected)
  })
})

describe('callStanding', () => {
  it('gives the key of the path a file tool’s call was decided by, resolved once', () => {
    let resolved = 0
    const counting: PathFs = {
      realpath: () => {
        resolved += 1
        return null
      },
      readlink: () => null,
    }
    const within = bounds({ fs: counting })
    resolved = 0

    expect(callStanding({ toolName: 'Read', input: { file_path: '/Users/me/Notes/a.md' } }, within)).toEqual({
      crossing: SandboxCrossing.None,
      key: '/users/me/notes/a.md',
    })
    // One walk up the path, and no more for the grants or the bounds: /Users/me/Notes/a.md and its four parents.
    expect(resolved).toBe(5)
    expect(callStanding({ toolName: 'Write', input: { file_path: '~/x.md' } }, within)).toEqual({
      crossing: SandboxCrossing.Boundary,
      key: '/users/me/x.md',
    })
    expect(callStanding({ toolName: 'Read', input: { file_path: '~/.ssh/id' } }, within)).toEqual({
      crossing: SandboxCrossing.Credential,
      key: '/users/me/.ssh/id',
    })
  })

  it('has no key for a call that names no file, or whose path can’t be resolved', () => {
    const within = bounds()
    const none = (toolName: string, input: ToolInput) => callStanding({ toolName, input }, within).key

    expect(none('Bash', { command: 'ls' })).toBeNull()
    expect(none('Bash', { command: 'ls', dangerouslyDisableSandbox: true })).toBeNull()
    expect(none('WebFetch', { url: 'https://docs.acme.dev/x' })).toBeNull()
    expect(none('SandboxNetworkAccess', { host: 'registry.npmjs.org' })).toBeNull()
    expect(none('Grep', { pattern: 'retry' })).toBeNull()
    const loop = bounds({ fs: fsWith({}, { '/Users/me/a': '/Users/me/b', '/Users/me/b': '/Users/me/a' }) })
    expect(callStanding({ toolName: 'Read', input: { file_path: '/Users/me/a/x' } }, loop)).toEqual({
      crossing: SandboxCrossing.Unresolvable,
      key: null,
    })
    expect(callStanding({ toolName: 'Write', input: { file_path: '/Users/me/a/x' } }, loop).key).toBeNull()
  })
})

describe('sandboxCrossing: reads', () => {
  it.each([
    ['a file in the workspace root', `${ROOT}/src/retry.ts`],
    ['the root itself', ROOT],
    ['a path relative to the root', 'src/retry.ts'],
    ['the root in another case', '/users/ME/src/Acme-API/README.md'],
    ['a file in a read-only grant', '/Users/me/notes/staging.md'],
    ['a file in a read-write grant', '/Users/me/src/shared-lib/index.ts'],
    ['a system file outside the home folder', '/etc/hosts'],
    ['a tool outside the home folder', '/usr/local/bin/node'],
    ['a Homebrew file', '/opt/homebrew/etc/redis.conf'],
    ['the temporary folder', '/tmp/build.log'],
    ['the system volume itself', '/System/Library/CoreServices/SystemVersion.plist'],
  ])("doesn't ask to read %s", (_what, path) => {
    expect(crossing('Read', { file_path: path })).toBe(SandboxCrossing.None)
  })

  it.each([
    ['elsewhere in the home folder', '/Users/me/Documents/taxes.pdf'],
    ['a sibling of the root', '/Users/me/src/other-app/README.md'],
    ['the home folder itself', HOME],
    ['a path relative to the root that climbs out', '../other-app/.env'],
    ["another user's files", '/Users/someone/notes.md'],
    ['/Users', '/Users'],
    ['a volume', '/Volumes/Backup/db.sql'],
    ['a folder whose name only starts like a grant', '/Users/me/notes-old/a.md'],
  ])('asks to read %s', (_what, path) => {
    expect(crossing('Read', { file_path: path })).toBe(SandboxCrossing.Boundary)
  })

  // Every other spelling of a folder the sandbox denies (the review's list).
  it.each([
    ['the home folder in lower case', '/users/me/Documents/taxes.pdf'],
    ['/Users in upper case', '/USERS/me/Documents/taxes.pdf'],
    ['a volume in lower case', '/volumes/Backup/db.sql'],
    ['the data volume’s alias', '/System/Volumes/Data/Users/me/Documents/taxes.pdf'],
    ['the data volume’s alias in another case', '/system/volumes/DATA/Users/me/Documents/taxes.pdf'],
    ['another system volume', '/System/Volumes/Preboot/secrets'],
    ['the home folder as ~', '~/Documents/taxes.pdf'],
    ['~ alone', '~'],
    ['the home folder with dots in it', '/Users/me/src/acme-api/../../Documents/taxes.pdf'],
  ])('asks to read %s', (_what, path) => {
    expect(crossing('Read', { file_path: path }, bounds({ grants: NO_GRANTS }))).toBe(SandboxCrossing.Boundary)
  })

  it('asks to read through a link in the root, or in the temporary folder, that leads into the home folder', () => {
    const fs = fsWith({
      [`${ROOT}/link/taxes.pdf`]: '/Users/me/Documents/taxes.pdf',
      [`${ROOT}/link`]: '/Users/me/Documents',
      '/tmp/claude/h': '/Users/me',
      [`${ROOT}/docs`]: `${ROOT}/documentation`,
    })
    const within = bounds({ grants: NO_GRANTS, fs })

    expect(crossing('Read', { file_path: `${ROOT}/link/taxes.pdf` }, within)).toBe(SandboxCrossing.Boundary)
    expect(crossing('Read', { file_path: 'link/not-there-yet.pdf' }, within)).toBe(SandboxCrossing.Boundary)
    expect(crossing('LS', { path: `${ROOT}/link` }, within)).toBe(SandboxCrossing.Boundary)
    expect(crossing('Read', { file_path: '/tmp/claude/h/Documents/taxes.pdf' }, within)).toBe(SandboxCrossing.Boundary)
    // A link that stays inside the root is the root.
    expect(crossing('Read', { file_path: `${ROOT}/docs/api.md` }, within)).toBe(SandboxCrossing.None)
  })

  it('reads a root that is itself reached through a link, by either name', () => {
    const fs = fsWith({ '/tmp/acme-api': '/private/tmp/acme-api', '/tmp': '/private/tmp' })
    const within = bounds({ root: '/tmp/acme-api', grants: NO_GRANTS, fs })

    expect(crossing('Write', { file_path: '/tmp/acme-api/out.txt' }, within)).toBe(SandboxCrossing.None)
    expect(crossing('Write', { file_path: '/private/tmp/acme-api/out.txt' }, within)).toBe(SandboxCrossing.None)
    expect(crossing('Write', { file_path: '/tmp/other/out.txt' }, within)).toBe(SandboxCrossing.Boundary)
  })

  it('can’t say where a path in a loop of links leads: it’s refused, not asked about', () => {
    const loop = fsWith({}, { [`${ROOT}/a`]: `${ROOT}/b`, [`${ROOT}/b`]: `${ROOT}/a` })
    const within = bounds({ grants: NO_GRANTS, fs: loop })

    expect(crossing('Read', { file_path: `${ROOT}/a/x` }, within)).toBe(SandboxCrossing.Unresolvable)
    expect(crossing('Write', { file_path: `${ROOT}/a/x` }, within)).toBe(SandboxCrossing.Unresolvable)
  })

  it.each([
    ['NotebookRead', { notebook_path: '/Users/me/lab/analysis.ipynb' }],
    ['LS', { path: '/Users/me/Downloads' }],
    ['Grep', { pattern: 'TODO', path: '/Users/me/other' }],
    ['Glob', { pattern: '*.md', path: '/Volumes/Archive' }],
  ])('holds %s to the same folders', (toolName, input) => {
    expect(crossing(toolName, input)).toBe(SandboxCrossing.Boundary)
    const everything = bounds({ grants: { folders: [{ path: '/Users', access: FolderAccess.Read }], domains: [] } })
    expect(
      crossing(toolName, { ...input, path: '/Users/me/other', notebook_path: '/Users/me/lab/a.ipynb' }, everything),
    ).toBe(SandboxCrossing.None)
  })

  it('lets a search with no path, or a read with no file, go: they search the root', () => {
    expect(crossing('Grep', { pattern: 'TODO' })).toBe(SandboxCrossing.None)
    expect(crossing('Read', { file_path: '  ' })).toBe(SandboxCrossing.None)
    expect(crossing('Read', { file_path: 42 })).toBe(SandboxCrossing.None)
  })

  it('reads a granted folder inside the root, and one that contains it', () => {
    const nested = bounds({
      grants: {
        folders: [
          { path: `${ROOT}/vendor`, access: FolderAccess.Read },
          { path: '/Users/me/src', access: FolderAccess.Read },
        ],
        domains: [],
      },
    })
    expect(crossing('Read', { file_path: '/Users/me/src/other-app/README.md' }, nested)).toBe(SandboxCrossing.None)
    expect(crossing('Write', { file_path: '/Users/me/src/other-app/README.md' }, nested)).toBe(SandboxCrossing.Boundary)
    expect(crossing('Write', { file_path: `${ROOT}/vendor/patch.diff` }, nested)).toBe(SandboxCrossing.None)
  })

  it('takes a root with a trailing slash, spaces or characters beyond ASCII', () => {
    for (const root of ['/Users/me/My Projects/acme api/', '/Users/me/Projets/café-日本']) {
      const within = bounds({ root, grants: NO_GRANTS })
      expect(crossing('Read', { file_path: `${root.replace(/\/$/, '')}/a b/ü.md` }, within)).toBe(SandboxCrossing.None)
      expect(crossing('Read', { file_path: '/Users/me/My Projects/other/ü.md' }, within)).toBe(SandboxCrossing.Boundary)
    }
    // The same name in the other Unicode form is the same folder.
    const accented = bounds({ root: '/Users/me/café', grants: NO_GRANTS })
    expect(crossing('Read', { file_path: '/Users/me/café/menu.md' }, accented)).toBe(SandboxCrossing.None)
  })

  it('takes a root outside the home folder', () => {
    for (const root of ['/Volumes/Projects/acme-api', '/tmp/acme-api']) {
      const within = bounds({ root, grants: NO_GRANTS })
      expect(crossing('Read', { file_path: `${root}/README.md` }, within)).toBe(SandboxCrossing.None)
      expect(crossing('Read', { file_path: '/Volumes/Projects/other/README.md' }, within)).toBe(
        SandboxCrossing.Boundary,
      )
      expect(crossing('Read', { file_path: '/Users/me/.zshrc' }, within)).toBe(SandboxCrossing.Boundary)
      expect(crossing('Write', { file_path: `${root}/out.txt` }, within)).toBe(SandboxCrossing.None)
    }
  })
})

describe('sandboxCrossing: credential paths', () => {
  const HOME_GRANTED = bounds({ grants: { folders: [{ path: HOME, access: FolderAccess.ReadWrite }], domains: [] } })

  it.each([
    ['a key', '/Users/me/.ssh/id_rsa'],
    ['the folder itself', '/Users/me/.aws'],
    ['a single credential file', '/Users/me/.docker/config.json'],
    ['in another case', '/USERS/me/.SSH/id_rsa'],
    ['through the data volume’s alias', '/System/Volumes/Data/Users/me/.ssh/id_rsa'],
    ['as ~', '~/.netrc'],
    ['the keychains', '/Users/me/Library/Keychains/login.keychain-db'],
  ])('refuses %s, read or write, even with the home folder granted', (_what, path) => {
    for (const within of [bounds({ grants: NO_GRANTS }), HOME_GRANTED]) {
      expect(crossing('Read', { file_path: path }, within)).toBe(SandboxCrossing.Credential)
      expect(crossing('Write', { file_path: path }, within)).toBe(SandboxCrossing.Credential)
    }
  })

  it('refuses one reached through a link in the root', () => {
    const fs = fsWith({ [`${ROOT}/keys`]: '/Users/me/.ssh' })
    expect(crossing('Read', { file_path: `${ROOT}/keys/id_rsa` }, bounds({ fs }))).toBe(SandboxCrossing.Credential)
  })

  it('leaves the files beside them alone', () => {
    expect(crossing('Read', { file_path: '/Users/me/.docker/daemon.json' }, HOME_GRANTED)).toBe(SandboxCrossing.None)
    expect(crossing('Read', { file_path: '/Users/me/.sshrc' }, HOME_GRANTED)).toBe(SandboxCrossing.None)
  })
})

describe('sandboxCrossing: writes', () => {
  it.each([
    ['Write', { file_path: `${ROOT}/CHANGELOG.md` }],
    ['Edit', { file_path: 'src/retry.ts' }],
    ['MultiEdit', { file_path: '/Users/me/src/shared-lib/index.ts' }],
    ['NotebookEdit', { notebook_path: `${ROOT}/analysis.ipynb` }],
  ])('%s inside the root or a read-write grant stays inside the bounds', (toolName, input) => {
    expect(crossing(toolName, input)).toBe(SandboxCrossing.None)
  })

  it.each([
    ['in a read-only grant', '/Users/me/notes/staging.md'],
    ['elsewhere in the home folder', '/Users/me/Desktop/plan.md'],
    ['outside the home folder', '/etc/hosts'],
    ['in the temporary folder', '/tmp/out.txt'],
    ['through ~', '~/Library/LaunchAgents/x.plist'],
  ])('asks to write %s', (_what, path) => {
    expect(crossing('Write', { file_path: path })).toBe(SandboxCrossing.Boundary)
    expect(crossing('Edit', { file_path: path })).toBe(SandboxCrossing.Boundary)
  })

  it('asks to write through a link in the root, even one to a folder that isn’t there yet', () => {
    const fs = fsWith({ '/Users/me': '/Users/me' }, { [`${ROOT}/out`]: '/Users/me/Library/LaunchAgents' })
    expect(crossing('Write', { file_path: `${ROOT}/out/x.plist` }, bounds({ fs }))).toBe(SandboxCrossing.Boundary)
  })

  it.each([
    ['the MCP servers the next session starts', `${ROOT}/.mcp.json`],
    ['Claude Code’s own settings', `${ROOT}/.claude/settings.local.json`],
    ['git’s config, which names commands git runs', `${ROOT}/.git/config`],
    ['a git hook', `${ROOT}/.git/hooks/pre-commit`],
    ['a nested repository’s config', `${ROOT}/vendor/lib/.git/config`],
    ['the editor’s tasks', `${ROOT}/.vscode/tasks.json`],
    ['a shell startup file', `${ROOT}/.zshrc`],
    ['in another case', `${ROOT}/.MCP.json`],
    ['inside a read-write grant', '/Users/me/src/shared-lib/.git/config'],
  ])('knows a write to %s for one that runs code', (_what, path) => {
    expect(crossing('Write', { file_path: path })).toBe(SandboxCrossing.Protected)
    expect(crossing('Edit', { file_path: path })).toBe(SandboxCrossing.Protected)
    // Reading it is as any other read.
    expect(crossing('Read', { file_path: path })).toBe(SandboxCrossing.None)
  })

  it('doesn’t take a file whose name only looks like one of those for one', () => {
    expect(crossing('Write', { file_path: `${ROOT}/docs/git/config.md` })).toBe(SandboxCrossing.None)
    expect(crossing('Write', { file_path: `${ROOT}/mcp.json` })).toBe(SandboxCrossing.None)
  })

  // Claude Code makes its subagents' worktrees under `.claude/worktrees`, and its own check leaves them out: Glade's
  // decides every write now (#514), so a worktree's files mustn't each ask.
  it('takes a worktree under .claude/worktrees for where an agent works, and what’s in it by the rest of its path', () => {
    const worktree = `${ROOT}/.claude/worktrees/agent-a1b2c3`
    expect(crossing('Write', { file_path: `${worktree}/src/retry.ts` })).toBe(SandboxCrossing.None)
    expect(crossing('Edit', { file_path: `${worktree}/README.md` })).toBe(SandboxCrossing.None)
    // What runs code inside the worktree still does.
    for (const path of ['.git', '.mcp.json', '.claude/settings.json', '.vscode/tasks.json', '.zshrc']) {
      expect(crossing('Write', { file_path: `${worktree}/${path}` })).toBe(SandboxCrossing.Protected)
    }
    // Only the first: a worktree's own `.claude/worktrees` is Claude Code's folder again.
    expect(crossing('Write', { file_path: `${worktree}/.claude/worktrees/nested/a.ts` })).toBe(
      SandboxCrossing.Protected,
    )
    // And the rest of Claude Code's own folder is as it was.
    expect(crossing('Write', { file_path: `${ROOT}/.claude/worktrees.json` })).toBe(SandboxCrossing.Protected)
    expect(crossing('Write', { file_path: `${ROOT}/.claude/skills/review/SKILL.md` })).toBe(SandboxCrossing.Protected)
    expect(crossing('Write', { file_path: `${ROOT}/worktrees/.claude/settings.json` })).toBe(SandboxCrossing.Protected)
  })

  // #514, finding 4: `Write ~/.zshrc` got the card for the file by itself, read-write, and `Write
  // ~/other/.git/hooks/pre-commit` the card for that folder: Allow for this task then granted the file that runs code.
  it.each([
    ['a shell startup file in the home folder', '/Users/me/.zshrc'],
    ['the user’s own git config', '~/.gitconfig'],
    ['a git hook in another repository', '/Users/me/src/other-app/.git/hooks/pre-commit'],
    ['Claude Code’s own settings', '/Users/me/.claude/settings.json'],
    ['an editor’s tasks outside the home folder', '/tmp/x/.vscode/tasks.json'],
    ['one inside a read-only grant', '/Users/me/notes/.zshrc'],
  ])(
    'knows a write to %s for one that runs code, outside the bounds too: never one a grant is offered for',
    (_what, path) => {
      expect(crossing('Write', { file_path: path })).toBe(SandboxCrossing.Protected)
      expect(crossing('Edit', { file_path: path })).toBe(SandboxCrossing.Protected)
    },
  )

  it('still refuses a credential path that’s also a file that runs code', () => {
    expect(crossing('Write', { file_path: '/Users/me/.ssh/.zshrc' })).toBe(SandboxCrossing.Credential)
  })
})

// #514, finding 1. macOS's magic folders name any file by another path, which `realpath` doesn't turn back: the key
// Glade compared was `/.nofollow/users/…`, under none of the bounded folders and matching no credential path, so
// `Read /.nofollow/Users/me/.ssh/id_rsa` was `allow / none`.
describe('sandboxCrossing: macOS’s magic folders', () => {
  it.each([
    ['/.nofollow', '/.nofollow/Users/me/.ssh/id_rsa'],
    ['/.vol, by device and inode', '/.vol/16777230/2/Users/me/.ssh/id_rsa'],
    ['/.resolve', '/.resolve/1/Users/me/.ssh/id_rsa'],
    ['/.nofollow, for any other file in the home folder', '/.nofollow/Users/me/Documents/taxes.pdf'],
    ['/.nofollow in another case', '/.NoFollow/Users/me/Documents/taxes.pdf'],
    ['/.vol in upper case', '/.VOL/16777230/2/Users/me/Documents/taxes.pdf'],
    ['one through the data volume’s alias', '/System/Volumes/Data/.nofollow/Users/me/.ssh/id_rsa'],
    ['one with dots in it', '/tmp/../.nofollow/Users/me/.ssh/id_rsa'],
    ['the magic folder itself', '/.vol'],
    ['one inside the workspace root, by its other name', `/.nofollow${ROOT}/README.md`],
  ])('can’t resolve a path through %s: read or write', (_what, path) => {
    for (const within of [bounds(), bounds({ grants: NO_GRANTS })]) {
      expect(callStanding({ toolName: 'Read', input: { file_path: path } }, within)).toEqual({
        crossing: SandboxCrossing.Unresolvable,
        key: null,
      })
      expect(crossing('Write', { file_path: path }, within)).toBe(SandboxCrossing.Unresolvable)
      expect(crossing('LS', { path }, within)).toBe(SandboxCrossing.Unresolvable)
      expect(crossing('NotebookEdit', { notebook_path: path }, within)).toBe(SandboxCrossing.Unresolvable)
    }
  })

  it('can’t resolve a link in the root that leads into one (`ln -s /.nofollow/Users/me/Documents link`)', () => {
    // As macOS answers: `realpath` hands `/.nofollow/…` back unchanged, and fails for the other two.
    const nofollow = fsWith({
      [`${ROOT}/link/taxes.pdf`]: '/.nofollow/Users/me/Documents/taxes.pdf',
      [`${ROOT}/link`]: '/.nofollow/Users/me/Documents',
    })
    const vol = fsWith({}, { [`${ROOT}/link`]: '/.vol/16777230/2/Users/me/Documents' })
    const resolve = fsWith({}, { [`${ROOT}/link`]: '../../../../../.resolve/1/Users/me/Documents' })

    for (const fs of [nofollow, vol, resolve]) {
      const within = bounds({ grants: NO_GRANTS, fs })
      expect(crossing('Read', { file_path: `${ROOT}/link/taxes.pdf` }, within)).toBe(SandboxCrossing.Unresolvable)
      expect(crossing('Read', { file_path: 'link/taxes.pdf' }, within)).toBe(SandboxCrossing.Unresolvable)
      expect(crossing('Write', { file_path: `${ROOT}/link/new.txt` }, within)).toBe(SandboxCrossing.Unresolvable)
    }
  })

  it('doesn’t take a name that only starts like one for one', () => {
    expect(crossing('Read', { file_path: '/.volumes/x' })).toBe(SandboxCrossing.None)
    expect(crossing('Read', { file_path: `${ROOT}/.vol/x` })).toBe(SandboxCrossing.None)
    expect(crossing('Read', { file_path: '/tmp/.nofollow/x' })).toBe(SandboxCrossing.None)
  })
})

// #514, finding 8: Glade's own data folder wasn't denied inside a grant.
describe('sandboxCrossing: Glade’s own data folder', () => {
  const DATA = '/Users/me/Library/Application Support/glade'
  const library: SandboxGrants = {
    folders: [{ path: '/Users/me/Library', access: FolderAccess.ReadWrite }],
    domains: [],
  }

  it('refuses it as a credential path, read or write, even inside a granted folder', () => {
    const within = bounds({ grants: library, denied: [DATA] })
    expect(crossing('Read', { file_path: `${DATA}/glade.db` }, within)).toBe(SandboxCrossing.Credential)
    expect(crossing('Write', { file_path: `${DATA}/glade.db` }, within)).toBe(SandboxCrossing.Credential)
    expect(crossing('Read', { file_path: '~/library/application support/GLADE/glade.db' }, within)).toBe(
      SandboxCrossing.Credential,
    )
    // What's beside it in the granted folder is as granted.
    expect(crossing('Write', { file_path: '/Users/me/Library/Caches/uv/x' }, within)).toBe(SandboxCrossing.None)
    // And without it named, the grant covers it: what the review found.
    expect(crossing('Write', { file_path: `${DATA}/glade.db` }, bounds({ grants: library }))).toBe(SandboxCrossing.None)
  })
})

describe('sandboxCrossing: domains', () => {
  it.each([
    ['https://registry.npmjs.org/react', SandboxCrossing.None],
    ['https://docs.acme.dev/api/retries', SandboxCrossing.None],
    ['https://acme.dev/', SandboxCrossing.Boundary],
    ['https://www.example.org/help/', SandboxCrossing.Boundary],
    ['https://registry.npmjs.org.evil.example/', SandboxCrossing.Boundary],
    ['not a url', SandboxCrossing.Boundary],
    ['file:///Users/me/notes.md', SandboxCrossing.Boundary],
  ])('WebFetch to %s', (url, expected) => {
    expect(crossing('WebFetch', { url, prompt: 'Summarize.' })).toBe(expected)
  })

  it('asks about WebFetch with no URL, and every connection a command asks about', () => {
    expect(crossing('WebFetch', { prompt: 'Summarize.' })).toBe(SandboxCrossing.Boundary)
    expect(crossing('SandboxNetworkAccess', { host: 'registry.npmjs.org' })).toBe(SandboxCrossing.Boundary)
  })

  it("never gates WebSearch: it has no domain to check, and runs on Anthropic's side", () => {
    expect(crossing('WebSearch', { query: 'exponential backoff' }, bounds({ grants: NO_GRANTS }))).toBe(
      SandboxCrossing.None,
    )
  })
})

describe('sandboxCrossing: running outside the sandbox', () => {
  it.each([true, 'true', 'TRUE', 'yes', 1, 0, '', {}, []])('takes %j for a request to', (value) => {
    expect(isSandboxOverride({ command: 'docker compose up -d', dangerouslyDisableSandbox: value })).toBe(true)
  })

  it.each([false, 'false', ' False ', null, undefined])('doesn’t take %j for one', (value) => {
    expect(isSandboxOverride({ command: 'docker compose up -d', dangerouslyDisableSandbox: value })).toBe(false)
  })

  it('knows the request by its input, whatever the tool or the command', () => {
    expect(isSandboxOverride({ command: 'docker compose up -d' })).toBe(false)
    expect(crossing('Bash', { command: `ls ${ROOT}`, dangerouslyDisableSandbox: true })).toBe(SandboxCrossing.Override)
    expect(crossing('Bash', { command: `ls ${ROOT}`, dangerouslyDisableSandbox: 'true' })).toBe(
      SandboxCrossing.Override,
    )
    expect(crossing('Monitor', { command: 'npm run dev', dangerouslyDisableSandbox: true })).toBe(
      SandboxCrossing.Override,
    )
  })

  it('lets other commands go: the sandbox bounds them', () => {
    expect(crossing('Bash', { command: 'cat /Users/me/.ssh/id_rsa' })).toBe(SandboxCrossing.None)
    expect(crossing('Monitor', { command: 'npm run dev' })).toBe(SandboxCrossing.None)
    expect(crossing(`mcp__${GLADE_SERVER}__set_status`, { status: 'Working.' })).toBe(SandboxCrossing.None)
  })

  // #514, finding 3: `sandbox.excludedCommands: ["docker *"]` in the user's or the project's settings runs the command
  // outside the sandbox without `dangerouslyDisableSandbox`, which was `allow / none` in Allow all.
  it('takes a command the user’s settings keep out of the sandbox for one, though it never asked to leave it', () => {
    const asked: string[] = []
    const within = bounds({
      unsandboxed: (command) => {
        asked.push(command)
        return command.includes('docker')
      },
    })

    expect(crossing('Bash', { command: 'docker run -v ~:/h alpine cat /h/.ssh/id_rsa' }, within)).toBe(
      SandboxCrossing.Override,
    )
    expect(crossing('Monitor', { command: 'docker logs -f api' }, within)).toBe(SandboxCrossing.Override)
    expect(crossing('Bash', { command: 'npm test' }, within)).toBe(SandboxCrossing.None)
    // Only a command is looked up: nothing for a call that names none, or another tool's `command`.
    expect(crossing('Bash', {}, within)).toBe(SandboxCrossing.None)
    expect(crossing('Bash', { command: 42 }, within)).toBe(SandboxCrossing.None)
    expect(crossing('mcp__docker__run', { command: 'docker ps' }, within)).toBe(SandboxCrossing.None)
    expect(asked).toEqual(['docker run -v ~:/h alpine cat /h/.ssh/id_rsa', 'docker logs -f api', 'npm test'])
  })

  it('names the tools whose every call is looked at before it runs', () => {
    expect([...BOUNDED_TOOLS].sort()).toEqual(
      [
        'Bash',
        'Edit',
        'Glob',
        'Grep',
        'LS',
        'Monitor',
        'MultiEdit',
        'NotebookEdit',
        'NotebookRead',
        'Read',
        'WebFetch',
        'Write',
      ].sort(),
    )
  })
})

describe('the rules a sandboxed session isn’t told of', () => {
  it('are the ones for a whole tool the sandbox bounds', () => {
    expect(isUnboundedRule({ toolName: 'Write' })).toBe(true)
    expect(isUnboundedRule({ toolName: 'Edit', ruleContent: ' ' })).toBe(true)
    expect(isUnboundedRule({ toolName: 'Read' })).toBe(true)
    expect(isUnboundedRule({ toolName: 'WebFetch' })).toBe(true)
    expect(isUnboundedRule({ toolName: 'Read', ruleContent: '//Users/me/notes/**' })).toBe(false)
    expect(isUnboundedRule({ toolName: 'WebFetch', ruleContent: 'domain:docs.acme.dev' })).toBe(false)
    expect(isUnboundedRule({ toolName: 'Bash', ruleContent: 'npm test *' })).toBe(false)
    expect(isUnboundedRule({ toolName: 'mcp__github__create_issue' })).toBe(false)
  })

  it('knows the tools that write', () => {
    expect(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].every(isWriteTool)).toBe(true)
    expect(['Read', 'Bash', 'WebFetch', 'toString'].some(isWriteTool)).toBe(false)
  })
})

describe('toolCallVerdict', () => {
  const plain = { mcpServer: null, matchedAskRule: false }
  interface Deciding {
    readonly within?: SandboxBounds | null
    readonly failed?: boolean
    readonly matchedAskRule?: boolean
    readonly writeRules?: readonly string[]
  }
  const decide = (
    toolName: string,
    input: ToolInput,
    permissionMode: PermissionMode,
    { within = bounds(), failed = false, matchedAskRule = false, writeRules = [] }: Deciding = {},
  ): ToolCallVerdict =>
    toolCallVerdict(
      { ...plain, matchedAskRule, toolName, input },
      {
        permissionMode,
        gladeServers: [GLADE_SERVER],
        sandbox: within === null ? null : { bounds: within, failed },
        writeRules,
      },
    )

  const MODES = [PermissionMode.AllowAll, PermissionMode.AskBeforeEdits]
  const ASK_AT_THE_BOUNDARY: ToolCallVerdict = { verdict: PermissionVerdict.Ask, crossing: SandboxCrossing.Boundary }
  const ALLOW: ToolCallVerdict = { verdict: PermissionVerdict.Allow, crossing: SandboxCrossing.None }
  const ASK: ToolCallVerdict = { verdict: PermissionVerdict.Ask, crossing: SandboxCrossing.None }

  it.each(MODES)('asks about every boundary crossing in %s', (mode) => {
    expect(decide('Read', { file_path: '/Users/me/Documents/taxes.pdf' }, mode)).toEqual(ASK_AT_THE_BOUNDARY)
    expect(decide('Read', { file_path: '/users/ME/Documents/taxes.pdf' }, mode)).toEqual(ASK_AT_THE_BOUNDARY)
    expect(decide('Write', { file_path: '/Users/me/notes/a.md' }, mode)).toEqual(ASK_AT_THE_BOUNDARY)
    expect(decide('WebFetch', { url: 'https://www.example.org/' }, mode)).toEqual(ASK_AT_THE_BOUNDARY)
    expect(decide('SandboxNetworkAccess', { host: 'www.example.org' }, mode)).toEqual(ASK_AT_THE_BOUNDARY)
  })

  it.each(MODES)("doesn't ask about reads inside the bounds, or outside the home folder, in %s", (mode) => {
    expect(decide('Read', { file_path: '/etc/hosts' }, mode)).toEqual(ALLOW)
    expect(decide('Read', { file_path: '/Users/me/notes/a.md' }, mode)).toEqual(ALLOW)
    expect(decide('WebFetch', { url: 'https://registry.npmjs.org/' }, mode)).toEqual(ALLOW)
    expect(decide('WebSearch', { query: 'backoff' }, mode)).toEqual(ALLOW)
  })

  it.each(MODES)('refuses a credential path in %s, without asking', (mode) => {
    const refused = { verdict: PermissionVerdict.Refuse, crossing: SandboxCrossing.Credential }
    expect(decide('Read', { file_path: '~/.ssh/id_rsa' }, mode)).toEqual(refused)
    expect(decide('Edit', { file_path: '/Users/me/.aws/credentials' }, mode)).toEqual(refused)
  })

  it.each(MODES)(
    'asks about running outside the sandbox in %s, even when a rule or Allow all would allow it',
    (mode) => {
      const input = { command: 'docker compose up -d', dangerouslyDisableSandbox: true }
      const asks = { verdict: PermissionVerdict.Ask, crossing: SandboxCrossing.Override }
      expect(decide('Bash', input, mode)).toEqual(asks)
      expect(decide('Bash', input, mode, { matchedAskRule: true })).toEqual(asks)
      expect(decide('Bash', { ...input, dangerouslyDisableSandbox: 'true' }, mode)).toEqual(asks)
    },
  )

  it.each(MODES)('refuses running outside a sandbox that couldn’t start, without asking, in %s', (mode) => {
    const input = { command: 'npm test', dangerouslyDisableSandbox: true }
    expect(decide('Bash', input, mode, { failed: true })).toEqual({
      verdict: PermissionVerdict.Refuse,
      crossing: SandboxCrossing.Override,
    })
    // Everything else is decided as before.
    expect(decide('Bash', { command: 'npm test' }, mode, { failed: true })).toEqual(
      mode === PermissionMode.AllowAll ? ALLOW : ASK,
    )
  })

  it.each(MODES)('asks about a write to a file that runs code in %s, whatever the task was granted', (mode) => {
    const held = { verdict: PermissionVerdict.Ask, crossing: SandboxCrossing.Protected }
    for (const file of ['.mcp.json', '.claude/settings.local.json', '.git/config']) {
      expect(decide('Write', { file_path: `${ROOT}/${file}` }, mode)).toEqual(held)
      expect(decide('Write', { file_path: `${ROOT}/${file}` }, mode, { writeRules: ['Write'] })).toEqual(held)
    }
  })

  it('in Allow all, asks about every write in the root that reaches it: acceptEdits lets the ordinary ones through by itself', () => {
    const mode = PermissionMode.AllowAll
    const held = { verdict: PermissionVerdict.Ask, crossing: SandboxCrossing.Protected }
    expect(decide('Write', { file_path: `${ROOT}/a.md` }, mode)).toEqual(held)
    expect(decide('Edit', { file_path: `${ROOT}/a.md` }, mode, { matchedAskRule: true })).toEqual(held)
    expect(decide('Edit', { file_path: `${ROOT}/a.md` }, mode, { writeRules: ['Edit'] })).toEqual(held)
    expect(decide('NotebookEdit', {}, mode)).toEqual(held)
  })

  // #514, finding 2: Claude Code isn't told of a granted folder any more, so it asks about every write in one. Before,
  // such a write that reached Glade in Allow all asked as Protected.
  it('in Allow all, lets a write inside a granted folder through: Claude Code asks about each, not knowing the grant', () => {
    const mode = PermissionMode.AllowAll
    const held = { verdict: PermissionVerdict.Ask, crossing: SandboxCrossing.Protected }
    expect(decide('Write', { file_path: '/Users/me/src/shared-lib/index.ts' }, mode)).toEqual(ALLOW)
    expect(decide('MultiEdit', { file_path: '/Users/me/src/shared-lib/a/b.ts' }, mode)).toEqual(ALLOW)
    // A single file granted read-write, too.
    const file = bounds({
      grants: { folders: [{ path: '/Users/me/todo.txt', access: FolderAccess.ReadWrite, file: true }], domains: [] },
    })
    expect(decide('Edit', { file_path: '~/todo.txt' }, mode, { within: file })).toEqual(ALLOW)
    // Never a file that runs code, and never one a user's own ask rule held back.
    expect(decide('Write', { file_path: '/Users/me/src/shared-lib/.git/hooks/pre-commit' }, mode)).toEqual(held)
    expect(decide('Write', { file_path: '/Users/me/src/shared-lib/.zshrc' }, mode)).toEqual(held)
    expect(decide('Write', { file_path: '/Users/me/src/shared-lib/a.ts' }, mode, { matchedAskRule: true })).toEqual(
      held,
    )
    // Nor a folder granted read-only.
    expect(decide('Write', { file_path: '/Users/me/notes/a.md' }, mode)).toEqual(ASK_AT_THE_BOUNDARY)
  })

  // #514, finding 2, the attack: `request_access("~/newcache", write)` is allowed for the task, then a sandboxed
  // command runs `rmdir ~/newcache && ln -s ~/Library/LaunchAgents ~/newcache`.
  it.each(MODES)('asks about a write through a granted folder swapped for a link, in %s', (mode) => {
    const grants: SandboxGrants = {
      folders: [{ path: '/Users/me/newcache', access: FolderAccess.ReadWrite }],
      domains: [],
    }
    const swapped = bounds({ grants, fs: fsWith({ '/Users/me/newcache': '/Users/me/Library/LaunchAgents' }) })

    expect(decide('Write', { file_path: '/Users/me/newcache/x.plist' }, mode, { within: swapped })).toEqual(
      ASK_AT_THE_BOUNDARY,
    )
    expect(decide('Write', { file_path: '~/Library/LaunchAgents/x.plist' }, mode, { within: swapped })).toEqual(
      ASK_AT_THE_BOUNDARY,
    )
    expect(decide('Read', { file_path: '/Users/me/newcache/x.plist' }, mode, { within: swapped })).toEqual(
      ASK_AT_THE_BOUNDARY,
    )
  })

  it.each(MODES)('asks about a write through a granted path that was missing, then made as a link, in %s', (mode) => {
    const grants: SandboxGrants = {
      folders: [{ path: '/Users/me/newcache', access: FolderAccess.ReadWrite }],
      domains: [],
    }
    // The link's target isn't there yet either: what's written through it lands there.
    const made = bounds({ grants, fs: fsWith({}, { '/Users/me/newcache': '/Users/me/Library/LaunchAgents' }) })

    expect(decide('Write', { file_path: '/Users/me/newcache/x.plist' }, mode, { within: made })).toEqual(
      ASK_AT_THE_BOUNDARY,
    )
    // While the path is what it was granted as (a folder, or still missing), a write in it goes ahead or asks as ever.
    const whole = bounds({ grants })
    expect(decide('Write', { file_path: '/Users/me/newcache/x.plist' }, mode, { within: whole })).toEqual(
      mode === PermissionMode.AllowAll ? ALLOW : ASK,
    )
  })

  it.each(MODES)('refuses a path through one of macOS’s magic folders in %s, without asking', (mode) => {
    const refused = { verdict: PermissionVerdict.Refuse, crossing: SandboxCrossing.Unresolvable }
    expect(decide('Read', { file_path: '/.nofollow/Users/me/.ssh/id_rsa' }, mode)).toEqual(refused)
    expect(decide('Read', { file_path: '/.vol/16777230/2/Users/me/.ssh/id_rsa' }, mode)).toEqual(refused)
    expect(decide('Read', { file_path: '/.resolve/1/Users/me/Documents/taxes.pdf' }, mode)).toEqual(refused)
    expect(decide('Write', { file_path: '/.nofollow/Users/me/.zshrc' }, mode)).toEqual(refused)
    // Whatever the task was granted, and whatever asked.
    expect(decide('Write', { file_path: '/.nofollow/Users/me/x' }, mode, { writeRules: ['Write'] })).toEqual(refused)
    expect(decide('Read', { file_path: '/.nofollow/Users/me/x' }, mode, { matchedAskRule: true })).toEqual(refused)
  })

  it.each(MODES)(
    'asks about a write to a file that runs code outside the bounds in %s, as one to allow once',
    (mode) => {
      const held = { verdict: PermissionVerdict.Ask, crossing: SandboxCrossing.Protected }
      expect(decide('Write', { file_path: '~/.zshrc' }, mode)).toEqual(held)
      expect(decide('Edit', { file_path: '/Users/me/src/other-app/.git/config' }, mode)).toEqual(held)
      expect(decide('Write', { file_path: '~/.zshrc' }, mode, { writeRules: ['Write'] })).toEqual(held)
    },
  )

  it.each(MODES)('asks about a command the user’s settings keep out of the sandbox in %s', (mode) => {
    const within = bounds({ unsandboxed: (command) => command.startsWith('docker') })
    const asks = { verdict: PermissionVerdict.Ask, crossing: SandboxCrossing.Override }
    expect(decide('Bash', { command: 'docker compose up -d' }, mode, { within })).toEqual(asks)
    expect(decide('Monitor', { command: 'docker logs -f api' }, mode, { within })).toEqual(asks)
    // And refuses it once the sandbox couldn't start: nothing runs unsandboxed then.
    expect(decide('Bash', { command: 'docker compose up -d' }, mode, { within, failed: true })).toEqual({
      verdict: PermissionVerdict.Refuse,
      crossing: SandboxCrossing.Override,
    })
    expect(decide('Bash', { command: 'npm test' }, mode, { within })).toEqual(
      mode === PermissionMode.AllowAll ? ALLOW : ASK,
    )
  })

  it('in Allow all, lets everything else inside the bounds go', () => {
    const mode = PermissionMode.AllowAll
    expect(decide('Bash', { command: 'npm test' }, mode)).toEqual(ALLOW)
    expect(decide('mcp__github__create_issue', {}, mode)).toEqual(ALLOW)
    expect(decide('Read', { file_path: `${ROOT}/.env` }, mode, { matchedAskRule: true })).toEqual(ALLOW)
  })

  it('asks in the ask mode about what it always has', () => {
    const mode = PermissionMode.AskBeforeEdits
    expect(decide('Bash', { command: 'npm test' }, mode)).toEqual(ASK)
    expect(decide('Write', { file_path: `${ROOT}/a.md` }, mode)).toEqual(ASK)
    expect(decide('Read', { file_path: `${ROOT}/a.md` }, mode)).toEqual(ALLOW)
  })

  it('in the ask mode, lets a tool the task was granted whole write inside the bounds, and nowhere else', () => {
    const mode = PermissionMode.AskBeforeEdits
    const granted = { writeRules: ['Write'] }
    expect(decide('Write', { file_path: `${ROOT}/a.md` }, mode, granted)).toEqual(ALLOW)
    expect(decide('Write', { file_path: '/Users/me/src/shared-lib/a.md' }, mode, granted)).toEqual(ALLOW)
    expect(decide('Write', { file_path: '/tmp/out.txt' }, mode, granted)).toEqual(ASK_AT_THE_BOUNDARY)
    expect(decide('Write', { file_path: '~/Library/LaunchAgents/x.plist' }, mode, granted)).toEqual(ASK_AT_THE_BOUNDARY)
    // Another tool wasn't granted, and a user's ask rule still asks.
    expect(decide('Edit', { file_path: `${ROOT}/a.md` }, mode, granted)).toEqual(ASK)
    expect(decide('Write', { file_path: `${ROOT}/a.md` }, mode, { ...granted, matchedAskRule: true })).toEqual(ASK)
  })

  it('with the sandbox off, decides as before: Allow all allows everything, the ask mode its own rules', () => {
    const off = { within: null }
    const outside = { file_path: '/Users/me/Documents/taxes.pdf' }
    const override = { command: 'npm test', dangerouslyDisableSandbox: true }
    expect(decide('Read', outside, PermissionMode.AllowAll, off)).toEqual(ALLOW)
    expect(decide('Bash', override, PermissionMode.AllowAll, off)).toEqual(ALLOW)
    expect(decide('Write', { file_path: '.mcp.json' }, PermissionMode.AllowAll, off)).toEqual(ALLOW)
    expect(decide('Read', outside, PermissionMode.AskBeforeEdits, off)).toEqual(ALLOW)
    expect(decide('Read', { file_path: '~/.ssh/id_rsa' }, PermissionMode.AskBeforeEdits, off)).toEqual(ALLOW)
    expect(decide('WebFetch', { url: 'https://www.example.org/' }, PermissionMode.AskBeforeEdits, off)).toEqual(ALLOW)
    expect(decide('Bash', override, PermissionMode.AskBeforeEdits, off)).toEqual(ASK)
    expect(decide('Write', outside, PermissionMode.AskBeforeEdits, { ...off, writeRules: ['Write'] })).toEqual(ASK)
  })
})
