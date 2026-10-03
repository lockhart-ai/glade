// The agent sandbox's settings (#445, `docs/sdk-notes.md` §15): what a session starts with, and the overlay its grants
// and permission mode make.
import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { PermissionMode } from '../../shared/domain'
import {
  autoAllowBashIfSandboxed,
  CREDENTIAL_PATHS,
  credentialDenyRules,
  credentialPaths,
  CredentialKind,
  GrantProblem,
  NO_GRANTS,
  SandboxAccess,
  sandboxFolder,
  sandboxOverlay,
  sandboxStartSettings,
  usableGrants,
  type SandboxGrants,
} from './sandbox'
import { SANDBOX_OVERRIDE_ASK_RULE } from './sandbox-requests'

const HOME = '/Users/me'
const ROOT = '/Users/me/src/acme-api'

/** Every credential path under `/Users/me`, as the sandbox's lists name them. */
const CREDENTIALS = [
  '/Users/me/.ssh',
  '/Users/me/.aws',
  '/Users/me/.gnupg',
  '/Users/me/.config/gh',
  '/Users/me/.config/gcloud',
  '/Users/me/.azure',
  '/Users/me/.kube',
  '/Users/me/Library/Keychains',
  '/Users/me/.netrc',
  '/Users/me/.git-credentials',
  '/Users/me/.docker/config.json',
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
        },
        network: { allowedDomains: [] },
        credentials: { files: CREDENTIALS.map((path) => ({ path, mode: 'deny' })) },
      },
      permissions: {
        ask: ['Bash(dangerouslyDisableSandbox:true)'],
        deny: credentialDenyRules(HOME),
      },
    })
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
    expect(CREDENTIAL_PATHS.map(({ path }) => path)).toEqual([
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
    ])
    expect(credentialPaths(`${HOME}/`).map(({ path }) => path)).toEqual(CREDENTIALS)
  })

  it('keeps the file tools out of them: a folder and everything in it, a file by itself', () => {
    const rules = credentialDenyRules(HOME)
    expect(rules).toContain('Read(//Users/me/.ssh/**)')
    expect(rules).toContain('Edit(//Users/me/.ssh/**)')
    expect(rules).toContain('Read(//Users/me/.netrc)')
    expect(rules).toContain('Edit(//Users/me/.docker/config.json)')
    expect(rules).toHaveLength(CREDENTIAL_PATHS.length * 2)
    expect(CREDENTIAL_PATHS.filter(({ kind }) => kind === CredentialKind.File)).toHaveLength(3)
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
      { path: '/Users/me/notes', access: SandboxAccess.Read },
      { path: '/Users/me/src/shared-lib/', access: SandboxAccess.ReadWrite },
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
        additionalDirectories: [],
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

  it('holds the file tools to the same folders: read-only ones as Read rules, read-write ones as directories', () => {
    const { permissions } = sandboxOverlay(ROOT, PermissionMode.AllowAll, grants, HOME)
    expect(permissions?.allow).toEqual([
      'Read(//Users/me/notes/**)',
      'WebFetch(domain:registry.npmjs.org)',
      'WebFetch(domain:*.acme.dev)',
    ])
    expect(permissions?.additionalDirectories).toEqual(['/Users/me/src/shared-lib'])
    expect(permissions?.allow).not.toContain('Read(//Users/me/src/shared-lib/**)')
  })

  it('grants domains as WebFetch rules in permissions only, never in the sandbox’s own list', () => {
    const overlay = sandboxOverlay(ROOT, PermissionMode.AllowAll, grants, HOME)
    expect(overlay.sandbox?.network?.allowedDomains).toEqual([])
    expect(JSON.stringify(overlay)).not.toContain('allowedTools')
  })

  it('keeps every credential path denied when the home folder itself is granted read-write', () => {
    const everything: SandboxGrants = { folders: [{ path: HOME, access: SandboxAccess.ReadWrite }], domains: [] }
    const { sandbox, permissions } = sandboxOverlay(ROOT, PermissionMode.AllowAll, everything, HOME)
    expect(sandbox?.filesystem?.allowWrite).toEqual([ROOT, HOME])
    expect(sandbox?.filesystem?.denyWrite).toEqual(CREDENTIALS)
    expect(sandbox?.credentials?.files).toEqual(CREDENTIALS.map((path) => ({ path, mode: 'deny' })))
    expect(permissions?.additionalDirectories).toEqual([HOME])
    expect(permissions?.deny).toEqual(credentialDenyRules(HOME))
    expect(permissions?.deny).toContain('Read(//Users/me/.ssh/**)')
  })

  it('keeps a credential file denied when its own folder is granted', () => {
    const docker: SandboxGrants = {
      folders: [{ path: '/Users/me/.docker', access: SandboxAccess.ReadWrite }],
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
        { path: `${ROOT}/vendor`, access: SandboxAccess.Read },
        { path: '/Users/me/src', access: SandboxAccess.Read },
      ],
      domains: [],
    }
    const { sandbox, permissions } = sandboxOverlay(ROOT, PermissionMode.AllowAll, nested, HOME)
    expect(sandbox?.filesystem?.allowRead).toEqual([ROOT, `${ROOT}/vendor`, '/Users/me/src'])
    // The root stays writable inside a read-only folder that contains it.
    expect(sandbox?.filesystem?.allowWrite).toEqual([ROOT])
    expect(permissions?.allow).toEqual(['Read(//Users/me/src/acme-api/vendor/**)', 'Read(//Users/me/src/**)'])
  })

  it('lists a folder granted twice, or as the root, once, and a domain granted twice once', () => {
    const twice: SandboxGrants = {
      folders: [
        { path: ROOT, access: SandboxAccess.ReadWrite },
        { path: '/Users/me/notes', access: SandboxAccess.Read },
        { path: '/Users/me/notes/', access: SandboxAccess.Read },
      ],
      domains: ['registry.npmjs.org', 'registry.npmjs.org'],
    }
    const { sandbox, permissions } = sandboxOverlay(`${ROOT}/`, PermissionMode.AllowAll, twice, HOME)
    expect(sandbox?.filesystem?.allowRead).toEqual([ROOT, '/Users/me/notes'])
    expect(sandbox?.filesystem?.allowWrite).toEqual([ROOT])
    expect(permissions?.allow).toEqual(['Read(//Users/me/notes/**)', 'WebFetch(domain:registry.npmjs.org)'])
  })

  it('writes folders with spaces, characters beyond ASCII and parentheses into rules as Claude Code reads them', () => {
    const odd: SandboxGrants = {
      folders: [
        { path: '/Users/me/My Notes', access: SandboxAccess.Read },
        { path: '/Volumes/Données/café (old)', access: SandboxAccess.Read },
      ],
      domains: [],
    }
    const { sandbox, permissions } = sandboxOverlay('/Volumes/Projets/日本', PermissionMode.AllowAll, odd, HOME)
    expect(permissions?.allow).toEqual(['Read(//Users/me/My Notes/**)', 'Read(//Volumes/Données/café \\(old\\)/**)'])
    expect(sandbox?.filesystem?.allowRead).toEqual([
      '/Volumes/Projets/日本',
      '/Users/me/My Notes',
      '/Volumes/Données/café (old)',
    ])
  })

  it('leaves out every grant that would open more than it names', () => {
    const wide: SandboxGrants = {
      folders: [
        { path: '/Users/me/a*', access: SandboxAccess.Read },
        { path: '/Users/me/Music [2024]', access: SandboxAccess.ReadWrite },
        { path: '/Users/me/x/../../..', access: SandboxAccess.ReadWrite },
        { path: '/', access: SandboxAccess.Read },
        { path: '', access: SandboxAccess.Read },
        { path: 'notes', access: SandboxAccess.ReadWrite },
        { path: '/Users/me/notes', access: SandboxAccess.Read },
      ],
      domains: ['*', 'registry.npmjs.org', 'https://evil.example/x', '*.acme.dev', 'a b.example', '*.*'],
    }
    const { sandbox, permissions } = sandboxOverlay(ROOT, PermissionMode.AllowAll, wide, HOME)

    expect(sandbox?.filesystem?.allowRead).toEqual([ROOT, '/Users/me/notes'])
    expect(sandbox?.filesystem?.allowWrite).toEqual([ROOT])
    expect(permissions?.additionalDirectories).toEqual([])
    expect(permissions?.allow).toEqual([
      'Read(//Users/me/notes/**)',
      'WebFetch(domain:registry.npmjs.org)',
      'WebFetch(domain:*.acme.dev)',
    ])
  })
})

describe('usableGrants', () => {
  it('keeps the grants the sandbox can take, their folders normalized', () => {
    const grants: SandboxGrants = {
      folders: [
        { path: '/Users/me/notes/', access: SandboxAccess.Read },
        { path: '/Users/me/src/./shared-lib', access: SandboxAccess.ReadWrite },
        { path: '/Users/me/My Notes (old)', access: SandboxAccess.Read },
      ],
      domains: ['registry.npmjs.org', '*.acme.dev', 'localhost'],
    }

    expect(usableGrants(grants)).toEqual({
      grants: {
        folders: [
          { path: '/Users/me/notes', access: SandboxAccess.Read },
          { path: '/Users/me/src/shared-lib', access: SandboxAccess.ReadWrite },
          { path: '/Users/me/My Notes (old)', access: SandboxAccess.Read },
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
    const { grants, rejected } = usableGrants({ folders: [{ path, access: SandboxAccess.Read }], domains: [] })
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
  ])('rejects the domain %j', (domain) => {
    const { grants, rejected } = usableGrants({ folders: [], domains: [domain] })
    expect(grants.domains).toEqual([])
    expect(rejected).toEqual([{ value: domain, problem: GrantProblem.NotAHost }])
  })
})
