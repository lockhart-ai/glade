// The agent sandbox's settings (#445, `docs/sdk-notes.md` §15): what a session starts with, and the overlay its grants
// and permission mode make.
import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { PermissionMode } from '../../shared/domain'
import { ControlEnv } from '../control/endpoint'
import {
  autoAllowBashIfSandboxed,
  CREDENTIAL_PATHS,
  credentialDenyRules,
  credentialPaths,
  CredentialKind,
  DENIED_ENV_VARS,
  fixedDenies,
  GrantProblem,
  isProtectedWrite,
  NO_GRANTS,
  PROTECTED_FILES,
  PROTECTED_FOLDERS,
  protectedWrites,
  sandboxFolder,
  sandboxOverlay,
  sandboxStartSettings,
  usableGrants,
  type SandboxGrants,
} from './sandbox'
import { FolderAccess } from '../../shared/sandbox'
import { SANDBOX_OVERRIDE_ASK_RULE } from './sandbox-requests'

const HOME = '/Users/me'
const ROOT = '/Users/me/src/acme-api'

/** The credential paths the sandbox denied before the phase's security review (#514), from the home folder. */
const FIRST_CREDENTIALS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gh',
  '.config/gcloud',
  '.azure',
  '.kube',
  'Library/Keychains',
  '.netrc',
  '.git-credentials',
  '.docker/config.json',
]

/** The ones the review added: Claude Code's own state, registry logins, and more cloud tools' tokens. */
const ADDED_CREDENTIALS = [
  '.claude.json',
  '.npmrc',
  '.pypirc',
  '.cargo/credentials',
  '.cargo/credentials.toml',
  '.gem/credentials',
  '.config/git/credentials',
  '.config/op',
  '.oci',
  '.config/doctl',
  '.config/hcloud',
  '.config/heroku',
  '.config/flyctl',
  '.fly',
  '.config/vercel',
  'Library/Application Support/com.vercel.cli',
  '.config/netlify',
  'Library/Preferences/netlify',
  '.config/.wrangler',
  '.wrangler',
  '.config/configstore',
  '.terraform.d/credentials.tfrc.json',
  '.pulumi/credentials.json',
  '.databrickscfg',
  '.config/rclone',
  '.boto',
  '.s3cfg',
]

/** Every credential path under `/Users/me`, as the sandbox's lists name them. */
const CREDENTIALS = [...FIRST_CREDENTIALS, ...ADDED_CREDENTIALS].map((path) => `/Users/me/${path}`)

/** The switches that would loosen the sandbox, each set off, and the variables kept from commands. */
const PINNED = {
  allowAppleEvents: false,
  enableWeakerNestedSandbox: false,
  enableWeakerNetworkIsolation: false,
  ignoreViolations: {},
}
const PINNED_NETWORK = { allowLocalBinding: false, allowAllUnixSockets: false, allowUnixSockets: [] }
const DENIED_VARIABLES = [
  { name: 'GLADE_CONTROL_URL', mode: 'deny' },
  { name: 'GLADE_CONTROL_TOKEN', mode: 'deny' },
]

describe('sandboxStartSettings', () => {
  it('starts with only the fixed parts: the root, the read denies, no domain, the credential denies and the ask rule', () => {
    expect(sandboxStartSettings(ROOT, HOME)).toEqual({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        filesystem: {
          denyRead: ['/Users/me', '/Users', '/Volumes'],
          allowRead: [ROOT],
          allowWrite: [ROOT],
          denyWrite: CREDENTIALS,
          disabled: false,
        },
        network: { allowedDomains: [], ...PINNED_NETWORK },
        credentials: { files: CREDENTIALS.map((path) => ({ path, mode: 'deny' })), envVars: DENIED_VARIABLES },
        ...PINNED,
      },
      permissions: {
        ask: ['Bash(dangerouslyDisableSandbox:true)'],
        deny: credentialDenyRules(HOME),
      },
    })
  })

  // #514, finding 3: a switch Glade leaves unset falls through from the user's own Claude Code settings. Each of these
  // set to true there (`sandbox.filesystem.disabled`, `allowAppleEvents`, a Docker socket in `allowUnixSockets`, …)
  // was honoured: Glade's flag settings said nothing of it.
  it('sets every switch that would loosen the sandbox, off, so none falls through from the user’s settings', () => {
    for (const settings of [
      sandboxStartSettings(ROOT, HOME),
      sandboxOverlay(ROOT, PermissionMode.AllowAll, NO_GRANTS, HOME),
    ]) {
      const { sandbox } = settings
      expect(sandbox?.filesystem?.disabled).toBe(false)
      expect(sandbox?.allowAppleEvents).toBe(false)
      expect(sandbox?.network?.allowLocalBinding).toBe(false)
      expect(sandbox?.network?.allowAllUnixSockets).toBe(false)
      expect(sandbox?.network?.allowUnixSockets).toEqual([])
      expect(sandbox?.enableWeakerNestedSandbox).toBe(false)
      expect(sandbox?.enableWeakerNetworkIsolation).toBe(false)
      expect(sandbox?.ignoreViolations).toEqual({})
      // Never said: the override must stay possible, asked about each time.
      expect(sandbox).not.toHaveProperty('allowUnsandboxedCommands')
      expect(sandbox).not.toHaveProperty('excludedCommands')
    }
  })

  // #514, finding 5: with "Let agents control Glade" on, a sandboxed command had the control endpoint's URL and token
  // in its environment, and could call the control API through the sandbox's proxy once `127.0.0.1` was allowed.
  it('keeps the control endpoint’s URL and token out of sandboxed commands’ environment', () => {
    expect([...DENIED_ENV_VARS].sort()).toEqual(Object.values(ControlEnv).sort())
    for (const settings of [
      sandboxStartSettings(ROOT, HOME),
      sandboxOverlay(ROOT, PermissionMode.AskBeforeEdits, NO_GRANTS, HOME),
    ]) {
      expect(settings.sandbox?.credentials?.envVars).toEqual(DENIED_VARIABLES)
    }
  })

  it("never says whether sandboxed commands ask: that's the overlay's, for the mode", () => {
    expect(sandboxStartSettings(ROOT, HOME).sandbox?.autoAllowBashIfSandboxed).toBeUndefined()
  })

  it('denies the home folder as an absolute path, never `~`', () => {
    const denied = sandboxStartSettings(ROOT, '/Users/someone else/').sandbox?.filesystem?.denyRead
    expect(denied).toEqual(['/Users/someone else', '/Users', '/Volumes'])
    expect(sandboxStartSettings(ROOT).sandbox?.filesystem?.denyRead?.[0]).toBe(homedir())
  })

  it.each([
    ['under the home folder', '/Users/me/src/acme-api', '/Users/me/src/acme-api'],
    ['on another volume', '/Volumes/Projects/acme-api', '/Volumes/Projects/acme-api'],
    ['in the temporary folder', '/tmp/acme-api', '/tmp/acme-api'],
    ['with spaces', '/Users/me/My Projects/acme api', '/Users/me/My Projects/acme api'],
    ['with characters beyond ASCII', '/Users/me/Projets/café-ü-日本', '/Users/me/Projets/café-ü-日本'],
    ['with a trailing slash', '/Users/me/src/acme-api/', '/Users/me/src/acme-api'],
    ['with a doubled slash and a dot', '/Users/me//src/./acme-api', '/Users/me/src/acme-api'],
  ])('allows reading and writing only a workspace root %s', (_where, root, folder) => {
    const { sandbox } = sandboxStartSettings(root, HOME)
    expect(sandbox?.filesystem?.allowRead).toEqual([folder])
    expect(sandbox?.filesystem?.allowWrite).toEqual([folder])
    expect(sandbox?.filesystem?.denyRead).toEqual([HOME, '/Users', '/Volumes'])
  })

  it('allows no domain, and carries no allow rule or additional directory: no grant at all', () => {
    const { sandbox, permissions } = sandboxStartSettings(ROOT, HOME)
    expect(sandbox?.network?.allowedDomains).toEqual([])
    expect(permissions?.allow).toBeUndefined()
    expect(permissions?.additionalDirectories).toBeUndefined()
  })
})

describe('credentials', () => {
  it('lists the credential paths as one named list, folders and files', () => {
    expect(CREDENTIAL_PATHS.map(({ path }) => path)).toEqual([...FIRST_CREDENTIALS, ...ADDED_CREDENTIALS])
    expect(credentialPaths(`${HOME}/`).map(({ path }) => path)).toEqual(CREDENTIALS)
  })

  // #514, finding 8: none of these was denied, so a grant of `~`, `~/.config` or `~/Library` opened them.
  it.each(['.claude.json', '.npmrc', '.pypirc', '.config/op', '.oci', '.config/doctl', '.fly'])(
    'denies ~/%s to commands and file tools, whatever is granted',
    (path) => {
      const everything: SandboxGrants = { folders: [{ path: HOME, access: FolderAccess.ReadWrite }], domains: [] }
      const { sandbox, permissions } = sandboxOverlay(ROOT, PermissionMode.AllowAll, everything, HOME)
      const absolute = `/Users/me/${path}`
      expect(sandbox?.filesystem?.denyWrite).toContain(absolute)
      expect(sandbox?.credentials?.files).toContainEqual({ path: absolute, mode: 'deny' })
      expect(permissions?.deny?.some((rule) => rule.startsWith(`Read(/${absolute}`))).toBe(true)
      expect(permissions?.deny?.some((rule) => rule.startsWith(`Edit(/${absolute}`))).toBe(true)
    },
  )

  it('keeps the file tools out of them: a folder and everything in it, a file by itself', () => {
    const rules = credentialDenyRules(HOME)
    expect(rules).toContain('Read(//Users/me/.ssh/**)')
    expect(rules).toContain('Edit(//Users/me/.ssh/**)')
    expect(rules).toContain('Read(//Users/me/.netrc)')
    expect(rules).toContain('Edit(//Users/me/.docker/config.json)')
    expect(rules).toHaveLength(CREDENTIAL_PATHS.length * 2)
    expect(CREDENTIAL_PATHS.filter(({ kind }) => kind === CredentialKind.File).map(({ path }) => path)).toEqual([
      '.netrc',
      '.git-credentials',
      '.docker/config.json',
      '.claude.json',
      '.npmrc',
      '.pypirc',
      '.cargo/credentials',
      '.cargo/credentials.toml',
      '.gem/credentials',
      '.config/git/credentials',
      '.terraform.d/credentials.tfrc.json',
      '.pulumi/credentials.json',
      '.databrickscfg',
      '.boto',
      '.s3cfg',
    ])
  })

  it('escapes a home folder whose name has parentheses, as a rule must', () => {
    expect(credentialDenyRules('/Users/me (work)')).toContain('Read(//Users/me \\(work\\)/.ssh/**)')
  })
})

describe('autoAllowBashIfSandboxed', () => {
  it('runs sandboxed commands without asking in Allow all, and asks about each in the ask mode', () => {
    expect(autoAllowBashIfSandboxed(PermissionMode.AllowAll)).toBe(true)
    expect(autoAllowBashIfSandboxed(PermissionMode.AskBeforeEdits)).toBe(false)
  })
})

describe('sandboxFolder', () => {
  it('normalizes a folder, without a trailing slash, leaving the root as it is', () => {
    expect(sandboxFolder('/Users/me/notes/')).toBe('/Users/me/notes')
    expect(sandboxFolder('/Users/me/../me/notes')).toBe('/Users/me/notes')
    expect(sandboxFolder('/')).toBe('/')
  })
})

describe('sandboxOverlay', () => {
  const grants: SandboxGrants = {
    folders: [
      { path: '/Users/me/notes', access: FolderAccess.Read },
      { path: '/Users/me/src/shared-lib/', access: FolderAccess.ReadWrite },
    ],
    domains: ['registry.npmjs.org', '*.acme.dev'],
  }

  it('with nothing granted, is the fixed parts and the mode', () => {
    const overlay = sandboxOverlay(ROOT, PermissionMode.AllowAll, NO_GRANTS, HOME)
    const start = sandboxStartSettings(ROOT, HOME)
    expect(overlay).toEqual({
      sandbox: { ...start.sandbox, autoAllowBashIfSandboxed: true },
      permissions: {
        allow: [],
        ask: [SANDBOX_OVERRIDE_ASK_RULE],
        deny: credentialDenyRules(HOME),
      },
    })
  })

  it('says whether sandboxed commands ask for the mode', () => {
    expect(sandboxOverlay(ROOT, PermissionMode.AllowAll, grants, HOME).sandbox?.autoAllowBashIfSandboxed).toBe(true)
    expect(sandboxOverlay(ROOT, PermissionMode.AskBeforeEdits, grants, HOME).sandbox?.autoAllowBashIfSandboxed).toBe(
      false,
    )
  })

  it('lets commands read every granted folder and write only the read-write ones, besides the root', () => {
    const filesystem = sandboxOverlay(ROOT, PermissionMode.AllowAll, grants, HOME).sandbox?.filesystem
    expect(filesystem?.allowRead).toEqual([ROOT, '/Users/me/notes', '/Users/me/src/shared-lib'])
    expect(filesystem?.allowWrite).toEqual([ROOT, '/Users/me/src/shared-lib'])
    expect(filesystem?.denyRead).toEqual([HOME, '/Users', '/Volumes'])
  })

  // #514, finding 2: a read-write grant was handed to Claude Code as an additional directory, and a read-only one as a
  // `Read(//<folder>/**)` rule. Claude Code resolves a directory itself, so `rmdir ~/newcache && ln -s
  // ~/Library/LaunchAgents ~/newcache` in a sandboxed command opened LaunchAgents to `Write`, with no card.
  it('tells the file tools of no grant: no additional directory, and no Read or Edit rule', () => {
    const { permissions } = sandboxOverlay(ROOT, PermissionMode.AllowAll, grants, HOME)
    expect(permissions?.allow).toEqual(['WebFetch(domain:registry.npmjs.org)', 'WebFetch(domain:*.acme.dev)'])
    expect(permissions).not.toHaveProperty('additionalDirectories')
    const rules = JSON.stringify(permissions?.allow)
    expect(rules).not.toContain('Read(')
    expect(rules).not.toContain('Edit(')
    // In either mode.
    const asking = sandboxOverlay(ROOT, PermissionMode.AskBeforeEdits, grants, HOME).permissions
    expect(asking?.allow).toEqual(permissions?.allow)
    expect(asking).not.toHaveProperty('additionalDirectories')
  })

  it('names a single file by itself for commands: its own path, and no rule or directory for the file tools', () => {
    const files: SandboxGrants = {
      folders: [
        { path: '/Users/me/.gitconfig', access: FolderAccess.Read, file: true },
        { path: '/Users/me/.zshrc', access: FolderAccess.ReadWrite, file: true },
        { path: '/Users/me/notes', access: FolderAccess.Read },
        { path: '/Users/me/src/shared-lib', access: FolderAccess.ReadWrite },
        // Granted twice: once.
        { path: '/Users/me/.zshrc', access: FolderAccess.ReadWrite, file: true },
      ],
      domains: ['registry.npmjs.org'],
    }

    const { sandbox, permissions } = sandboxOverlay(ROOT, PermissionMode.AllowAll, files, HOME)

    // Commands may read both files, and write the read-write one.
    expect(sandbox?.filesystem?.allowRead).toEqual([
      ROOT,
      '/Users/me/.gitconfig',
      '/Users/me/.zshrc',
      '/Users/me/notes',
      '/Users/me/src/shared-lib',
    ])
    expect(sandbox?.filesystem?.allowWrite).toEqual([ROOT, '/Users/me/.zshrc', '/Users/me/src/shared-lib'])
    // The file tools get no rule for either: Glade decides their calls itself.
    expect(permissions?.allow).toEqual(['WebFetch(domain:registry.npmjs.org)'])
    expect(permissions).not.toHaveProperty('additionalDirectories')
    const everything = JSON.stringify({ sandbox, permissions })
    expect(everything).not.toContain('/Users/me/.gitconfig/**')
    expect(everything).not.toContain('/Users/me/.zshrc/**')
    // The files that run code are write-protected under the folder granted read-write, never under a single file.
    expect(sandbox?.filesystem?.denyWrite).toContain('/Users/me/src/shared-lib/.git/hooks')
    expect(everything).not.toContain('/Users/me/.zshrc/.git')
    // And their folder, the home folder, is opened nowhere.
    for (const opened of [sandbox?.filesystem?.allowRead, sandbox?.filesystem?.allowWrite]) {
      expect(opened).not.toContain(HOME)
    }
    expect(permissions?.allow).not.toContain('Read(//Users/me/**)')
  })

  it('grants domains as WebFetch rules in permissions only, never in the sandbox’s own list', () => {
    const overlay = sandboxOverlay(ROOT, PermissionMode.AllowAll, grants, HOME)
    expect(overlay.sandbox?.network?.allowedDomains).toEqual([])
    expect(JSON.stringify(overlay)).not.toContain('allowedTools')
  })

  it('keeps every credential path denied when the home folder itself is granted read-write', () => {
    const everything: SandboxGrants = { folders: [{ path: HOME, access: FolderAccess.ReadWrite }], domains: [] }
    const { sandbox, permissions } = sandboxOverlay(ROOT, PermissionMode.AllowAll, everything, HOME)
    expect(sandbox?.filesystem?.allowWrite).toEqual([ROOT, HOME])
    expect(sandbox?.filesystem?.denyWrite).toEqual([...CREDENTIALS, ...protectedWrites(HOME)])
    expect(sandbox?.credentials?.files).toEqual(CREDENTIALS.map((path) => ({ path, mode: 'deny' })))
    expect(permissions?.deny).toEqual(credentialDenyRules(HOME))
    expect(permissions?.deny).toContain('Read(//Users/me/.ssh/**)')
  })

  it('keeps a credential file denied when its own folder is granted', () => {
    const docker: SandboxGrants = {
      folders: [{ path: '/Users/me/.docker', access: FolderAccess.ReadWrite }],
      domains: [],
    }
    const { sandbox, permissions } = sandboxOverlay(ROOT, PermissionMode.AllowAll, docker, HOME)
    expect(sandbox?.filesystem?.denyWrite).toContain('/Users/me/.docker/config.json')
    expect(sandbox?.credentials?.files).toContainEqual({ path: '/Users/me/.docker/config.json', mode: 'deny' })
    expect(permissions?.deny).toContain('Read(//Users/me/.docker/config.json)')
  })

  it('takes a granted folder inside the workspace root, and one that contains it, as they are', () => {
    const nested: SandboxGrants = {
      folders: [
        { path: `${ROOT}/vendor`, access: FolderAccess.Read },
        { path: '/Users/me/src', access: FolderAccess.Read },
      ],
      domains: [],
    }
    const { sandbox, permissions } = sandboxOverlay(ROOT, PermissionMode.AllowAll, nested, HOME)
    expect(sandbox?.filesystem?.allowRead).toEqual([ROOT, `${ROOT}/vendor`, '/Users/me/src'])
    // The root stays writable inside a read-only folder that contains it.
    expect(sandbox?.filesystem?.allowWrite).toEqual([ROOT])
    expect(permissions?.allow).toEqual([])
  })

  it('lists a folder granted twice, or as the root, once, and a domain granted twice once', () => {
    const twice: SandboxGrants = {
      folders: [
        { path: ROOT, access: FolderAccess.ReadWrite },
        { path: '/Users/me/notes', access: FolderAccess.Read },
        { path: '/Users/me/notes/', access: FolderAccess.Read },
      ],
      domains: ['registry.npmjs.org', 'registry.npmjs.org'],
    }
    const { sandbox, permissions } = sandboxOverlay(`${ROOT}/`, PermissionMode.AllowAll, twice, HOME)
    expect(sandbox?.filesystem?.allowRead).toEqual([ROOT, '/Users/me/notes'])
    expect(sandbox?.filesystem?.allowWrite).toEqual([ROOT])
    expect(permissions?.allow).toEqual(['WebFetch(domain:registry.npmjs.org)'])
    // The root granted read-write again protects the same names in it, each once.
    const denied = sandbox?.filesystem?.denyWrite ?? []
    expect(new Set(denied).size).toBe(denied.length)
  })

  it('lists folders with spaces, characters beyond ASCII and parentheses as they are', () => {
    const odd: SandboxGrants = {
      folders: [
        { path: '/Users/me/My Notes', access: FolderAccess.Read },
        { path: '/Volumes/Données/café (old)', access: FolderAccess.ReadWrite },
      ],
      domains: [],
    }
    const { sandbox, permissions } = sandboxOverlay('/Volumes/Projets/日本', PermissionMode.AllowAll, odd, HOME)
    expect(permissions?.allow).toEqual([])
    expect(sandbox?.filesystem?.denyWrite).toContain('/Volumes/Données/café (old)/**/.zshrc')
    expect(sandbox?.filesystem?.allowRead).toEqual([
      '/Volumes/Projets/日本',
      '/Users/me/My Notes',
      '/Volumes/Données/café (old)',
    ])
  })

  it('leaves out every grant that would open more than it names', () => {
    const wide: SandboxGrants = {
      folders: [
        { path: '/Users/me/a*', access: FolderAccess.Read },
        { path: '/Users/me/Music [2024]', access: FolderAccess.ReadWrite },
        { path: '/Users/me/x/../../..', access: FolderAccess.ReadWrite },
        { path: '/', access: FolderAccess.Read },
        { path: '', access: FolderAccess.Read },
        { path: 'notes', access: FolderAccess.ReadWrite },
        { path: '/Users/me/notes', access: FolderAccess.Read },
      ],
      domains: ['*', 'registry.npmjs.org', 'https://evil.example/x', '*.acme.dev', 'a b.example', '*.*'],
    }
    const { sandbox, permissions } = sandboxOverlay(ROOT, PermissionMode.AllowAll, wide, HOME)

    expect(sandbox?.filesystem?.allowRead).toEqual([ROOT, '/Users/me/notes'])
    expect(sandbox?.filesystem?.allowWrite).toEqual([ROOT])
    expect(permissions?.allow).toEqual(['WebFetch(domain:registry.npmjs.org)', 'WebFetch(domain:*.acme.dev)'])
    // Nothing of a rejected folder reaches the write denies either: a pattern there would deny more than it names.
    expect(JSON.stringify(sandbox?.filesystem?.denyWrite)).not.toContain('Music')
  })
})

// #514, finding 4, probed: inside a folder granted read-write and outside the workspace, a sandboxed
// `echo … >> <granted>/.zshrc` and a write to `<granted>/.git/hooks/pre-commit` both succeeded. Claude Code protects
// those names under the workspace root only.
describe('the files that run code, inside a folder granted read-write', () => {
  const GRANTED = '/Users/me/src/shared-lib'
  const overlay = (folders: SandboxGrants['folders']): readonly string[] =>
    sandboxOverlay(ROOT, PermissionMode.AllowAll, { folders, domains: [] }, HOME).sandbox?.filesystem?.denyWrite ?? []

  it.each([
    `${GRANTED}/.zshrc`,
    `${GRANTED}/.zshenv`,
    `${GRANTED}/.bashrc`,
    `${GRANTED}/.bash_profile`,
    `${GRANTED}/.profile`,
    `${GRANTED}/.gitconfig`,
    `${GRANTED}/.gitmodules`,
    `${GRANTED}/.mcp.json`,
    `${GRANTED}/.ripgreprc`,
    `${GRANTED}/.git/hooks`,
    `${GRANTED}/.git/config`,
    `${GRANTED}/.vscode`,
    `${GRANTED}/.idea`,
    `${GRANTED}/.claude/commands`,
    `${GRANTED}/.claude/agents`,
    `${GRANTED}/.claude/skills`,
    `${GRANTED}/.claude/hooks`,
    `${GRANTED}/.claude/settings.json`,
    `${GRANTED}/.claude/settings.local.json`,
  ])('keeps a command from writing %s', (path) => {
    expect(overlay([{ path: GRANTED, access: FolderAccess.ReadWrite }])).toContain(path)
  })

  it('denies each by a pattern too, for the same name in any folder under the grant', () => {
    const denied = overlay([{ path: GRANTED, access: FolderAccess.ReadWrite }])
    expect(denied).toContain(`${GRANTED}/**/.zshrc`)
    expect(denied).toContain(`${GRANTED}/**/.git/config`)
    expect(denied).toContain(`${GRANTED}/**/.git/hooks/**`)
    expect(denied).toContain(`${GRANTED}/**/.vscode/**`)
    expect(denied).toContain(`${GRANTED}/**/.claude/settings.json`)
  })

  it('leaves the rest of a repository’s own folder writable, so a command can commit there', () => {
    const denied = overlay([{ path: GRANTED, access: FolderAccess.ReadWrite }])
    expect(denied).not.toContain(`${GRANTED}/.git`)
    expect(denied).not.toContain(`${GRANTED}/.claude`)
    expect(denied.some((path) => path.endsWith('/.git/**') || path.endsWith('/.claude/**'))).toBe(false)
  })

  it('protects nothing under a folder granted read-only, which no command can write, or under a single file', () => {
    const credentials = overlay([])
    expect(overlay([{ path: GRANTED, access: FolderAccess.Read }])).toEqual(credentials)
    expect(overlay([{ path: '/Users/me/.zshrc', access: FolderAccess.ReadWrite, file: true }])).toEqual(credentials)
  })

  it('protects them under every folder granted read-write, and never under the root (Claude Code does that)', () => {
    const denied = overlay([
      { path: GRANTED, access: FolderAccess.ReadWrite },
      { path: '/Users/me/.cache/uv', access: FolderAccess.ReadWrite },
    ])
    expect(denied).toContain(`${GRANTED}/.zshrc`)
    expect(denied).toContain('/Users/me/.cache/uv/.zshrc')
    expect(denied).not.toContain(`${ROOT}/.zshrc`)
    expect(sandboxStartSettings(ROOT, HOME).sandbox?.filesystem?.denyWrite).toEqual(CREDENTIALS)
  })

  it('protects what’s directly in a granted folder that is itself a repository’s own, or Claude Code’s', () => {
    expect(protectedWrites('/Users/me/src/shared-lib/.git')).toEqual(
      expect.arrayContaining(['/Users/me/src/shared-lib/.git/hooks', '/Users/me/src/shared-lib/.git/config']),
    )
    expect(protectedWrites('/Users/me/src/shared-lib/.claude')).toEqual(
      expect.arrayContaining([
        '/Users/me/src/shared-lib/.claude/commands',
        '/Users/me/src/shared-lib/.claude/hooks',
        '/Users/me/src/shared-lib/.claude/settings.json',
      ]),
    )
    expect(protectedWrites(GRANTED)).not.toContain(`${GRANTED}/hooks`)
  })

  it('names the same files the file tools are asked about, and the folders they’re in', () => {
    expect(PROTECTED_FILES).toEqual(expect.arrayContaining(['.zshrc', '.zshenv', '.gitconfig', '.mcp.json']))
    expect(PROTECTED_FOLDERS).toEqual(['.git', '.claude', '.vscode', '.idea'])
    for (const name of PROTECTED_FILES) expect(protectedWrites(GRANTED)).toContain(`${GRANTED}/${name}`)
  })

  it.each([
    ['/users/me/proj/.zshrc', true],
    ['/users/me/proj/sub/.git/config', true],
    ['/users/me/proj/.git/hooks', true],
    ['/users/me/proj/.git/hooks/pre-commit', true],
    ['/users/me/proj/.vscode/tasks.json', true],
    ['/users/me/proj/.claude/settings.local.json', true],
    ['/users/me/proj/.claude/skills/x/skill.md', true],
    ['/users/me/proj/.git', false],
    ['/users/me/proj/.git/objects/ab/cdef', false],
    ['/users/me/proj/.claude/worktrees/agent-1/src/a.ts', false],
    ['/users/me/proj/zshrc', false],
    ['/users/me/proj', false],
  ])('says whether a command is kept from writing %s: %s', (path, kept) => {
    expect(isProtectedWrite(path)).toBe(kept)
  })
})

// #514, finding 8: Glade's own data folder (the database, with the grants, the settings and the control token) wasn't
// denied inside a grant: a read-write grant of `~/Library` let a command turn the sandbox off.
describe('Glade’s own data folder', () => {
  const DATA = '/Users/me/Library/Application Support/glade'
  const library: SandboxGrants = {
    folders: [{ path: '/Users/me/Library', access: FolderAccess.ReadWrite }],
    domains: [],
  }

  it('is shut to commands and file tools at start, as a credential folder is', () => {
    const { sandbox, permissions } = sandboxStartSettings(ROOT, HOME, [`${DATA}/`])
    expect(sandbox?.filesystem?.denyWrite).toEqual([...CREDENTIALS, DATA])
    expect(sandbox?.credentials?.files).toContainEqual({ path: DATA, mode: 'deny' })
    expect(permissions?.deny).toEqual([...credentialDenyRules(HOME), `Read(/${DATA}/**)`, `Edit(/${DATA}/**)`])
  })

  it('stays shut inside a folder granted read-write that holds it', () => {
    const { sandbox, permissions } = sandboxOverlay(ROOT, PermissionMode.AllowAll, library, HOME, [DATA])
    expect(sandbox?.filesystem?.allowWrite).toEqual([ROOT, '/Users/me/Library'])
    expect(sandbox?.filesystem?.denyWrite).toContain(DATA)
    expect(sandbox?.credentials?.files).toContainEqual({ path: DATA, mode: 'deny' })
    expect(permissions?.deny).toContain(`Read(/${DATA}/**)`)
    expect(permissions?.deny).toContain(`Edit(/${DATA}/**)`)
  })

  it('is left out for a workspace inside it: the root is always the agent’s to use', () => {
    const inside = `${DATA}/scratch`
    expect(fixedDenies(inside, HOME, [DATA]).map(({ path }) => path)).toEqual(CREDENTIALS)
    expect(fixedDenies(DATA, HOME, [DATA]).map(({ path }) => path)).toEqual(CREDENTIALS)
    expect(sandboxStartSettings(inside, HOME, [DATA]).sandbox?.filesystem?.denyWrite).toEqual(CREDENTIALS)
    // A workspace beside it, or one that holds it, keeps it shut.
    expect(fixedDenies('/Users/me/Library', HOME, [DATA]).map(({ path }) => path)).toContain(DATA)
    expect(fixedDenies(`${DATA}-notes`, HOME, [DATA]).map(({ path }) => path)).toContain(DATA)
  })

  it('is denied once, however often it’s named', () => {
    expect(fixedDenies(ROOT, HOME, [DATA, `${DATA}/`, DATA]).filter(({ path }) => path === DATA)).toHaveLength(1)
  })
})

describe('usableGrants', () => {
  it('keeps the grants the sandbox can take, their folders normalized', () => {
    const grants: SandboxGrants = {
      folders: [
        { path: '/Users/me/notes/', access: FolderAccess.Read },
        { path: '/Users/me/src/./shared-lib', access: FolderAccess.ReadWrite },
        { path: '/Users/me/My Notes (old)', access: FolderAccess.Read },
      ],
      domains: ['registry.npmjs.org', '*.acme.dev', 'localhost'],
    }

    expect(usableGrants(grants)).toEqual({
      grants: {
        folders: [
          { path: '/Users/me/notes', access: FolderAccess.Read },
          { path: '/Users/me/src/shared-lib', access: FolderAccess.ReadWrite },
          { path: '/Users/me/My Notes (old)', access: FolderAccess.Read },
        ],
        domains: ['registry.npmjs.org', '*.acme.dev', 'localhost'],
      },
      rejected: [],
    })
    expect(usableGrants(NO_GRANTS)).toEqual({ grants: NO_GRANTS, rejected: [] })
  })

  it.each([
    ['', GrantProblem.NotAbsolute],
    ['notes', GrantProblem.NotAbsolute],
    ['./notes', GrantProblem.NotAbsolute],
    ['~/notes', GrantProblem.NotAbsolute],
    ['/', GrantProblem.WholeDisk],
    ['//', GrantProblem.WholeDisk],
    ['/Users/me/x/../../..', GrantProblem.WholeDisk],
    ['/Users/me/a*', GrantProblem.Pattern],
    ['/Users/me/a?c', GrantProblem.Pattern],
    ['/Users/me/Music [2024]', GrantProblem.Pattern],
    ['/Users/me/{a,b}', GrantProblem.Pattern],
    ['/Users/me/a\\*', GrantProblem.Pattern],
    ['/Users/**', GrantProblem.Pattern],
  ])('rejects the folder %j', (path, problem) => {
    const { grants, rejected } = usableGrants({ folders: [{ path, access: FolderAccess.Read }], domains: [] })
    expect(grants.folders).toEqual([])
    expect(rejected).toEqual([{ value: path, problem }])
  })

  it.each([
    '*',
    '*.*',
    '',
    '*.',
    'https://registry.npmjs.org',
    'registry.npmjs.org/x',
    'a b.example',
    'evil.example:443',
    '**.acme.dev',
    'acme.*',
    // #514, finding 5: each is `127.0.0.1` in another spelling, and a grant of it read as anything but.
    '2130706433',
    '0x7f.1',
    '0x7f000001',
    '127.1',
    '0177.0.0.1',
    '127.0.0.256',
    '*.0x7f.1',
  ])('rejects the domain %j', (domain) => {
    const { grants, rejected } = usableGrants({ folders: [], domains: [domain] })
    expect(grants.domains).toEqual([])
    expect(rejected).toEqual([{ value: domain, problem: GrantProblem.NotAHost }])
  })
})
