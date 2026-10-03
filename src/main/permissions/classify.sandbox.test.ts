// Which calls ask with the agent sandbox on (#445): crossing its bounds asks in either mode, running outside it always
// asks (or is refused, once it couldn't start), and reads outside the home folder go ahead.
import { describe, expect, it } from 'vitest'
import { PermissionMode, type ToolInput } from '../../shared/domain'
import { GLADE_SERVER } from '../agent/glade-tools'
import { NO_GRANTS, SandboxAccess, type SandboxGrants } from '../agent/sandbox'
import {
  isSandboxOverride,
  PermissionVerdict,
  sandboxCrossing,
  SandboxCrossing,
  toolCallVerdict,
  type SandboxScope,
} from './classify'

const HOME = '/Users/me'
const ROOT = '/Users/me/src/acme-api'

const GRANTS: SandboxGrants = {
  folders: [
    { path: '/Users/me/notes', access: SandboxAccess.Read },
    { path: '/Users/me/src/shared-lib/', access: SandboxAccess.ReadWrite },
  ],
  domains: ['registry.npmjs.org', '*.acme.dev'],
}

function scope(overrides: Partial<SandboxScope> = {}): SandboxScope {
  return { root: ROOT, home: HOME, grants: GRANTS, failed: false, ...overrides }
}

function crossing(toolName: string, input: ToolInput, within: SandboxScope = scope()): SandboxCrossing {
  return sandboxCrossing({ toolName, input }, within)
}

describe('sandboxCrossing: reads', () => {
  it.each([
    ['a file in the workspace root', `${ROOT}/src/retry.ts`],
    ['the root itself', ROOT],
    ['a path relative to the root', 'src/retry.ts'],
    ['a file in a read-only grant', '/Users/me/notes/staging.md'],
    ['a file in a read-write grant', '/Users/me/src/shared-lib/index.ts'],
    ['a system file outside the home folder', '/etc/hosts'],
    ['a tool outside the home folder', '/usr/local/bin/node'],
    ['a Homebrew file', '/opt/homebrew/etc/redis.conf'],
    ['the temporary folder', '/tmp/build.log'],
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

  it.each([
    ['NotebookRead', { notebook_path: '/Users/me/lab/analysis.ipynb' }],
    ['LS', { path: '/Users/me/Downloads' }],
    ['Grep', { pattern: 'TODO', path: '/Users/me/other' }],
    ['Glob', { pattern: '*.md', path: '/Volumes/Archive' }],
  ])('holds %s to the same folders', (toolName, input) => {
    expect(crossing(toolName, input)).toBe(SandboxCrossing.Boundary)
    expect(
      crossing(
        toolName,
        input,
        scope({ grants: { folders: [{ path: '/', access: SandboxAccess.Read }], domains: [] } }),
      ),
    ).toBe(SandboxCrossing.None)
  })

  it('lets a search with no path, or a read with no file, go: they search the root', () => {
    expect(crossing('Grep', { pattern: 'TODO' })).toBe(SandboxCrossing.None)
    expect(crossing('Read', { file_path: '  ' })).toBe(SandboxCrossing.None)
    expect(crossing('Read', { file_path: 42 })).toBe(SandboxCrossing.None)
  })

  it('reads a granted folder inside the root, and one that contains it', () => {
    const nested = scope({
      grants: {
        folders: [
          { path: `${ROOT}/vendor`, access: SandboxAccess.Read },
          { path: '/Users/me/src', access: SandboxAccess.Read },
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
      const within = scope({ root, grants: NO_GRANTS })
      expect(crossing('Read', { file_path: `${root.replace(/\/$/, '')}/a b/ü.md` }, within)).toBe(SandboxCrossing.None)
      expect(crossing('Read', { file_path: '/Users/me/My Projects/other/ü.md' }, within)).toBe(SandboxCrossing.Boundary)
    }
  })

  it('takes a root outside the home folder', () => {
    for (const root of ['/Volumes/Projects/acme-api', '/tmp/acme-api']) {
      const within = scope({ root, grants: NO_GRANTS })
      expect(crossing('Read', { file_path: `${root}/README.md` }, within)).toBe(SandboxCrossing.None)
      expect(crossing('Read', { file_path: '/Volumes/Projects/other/README.md' }, within)).toBe(
        SandboxCrossing.Boundary,
      )
      expect(crossing('Read', { file_path: '/Users/me/.zshrc' }, within)).toBe(SandboxCrossing.Boundary)
      expect(crossing('Write', { file_path: `${root}/out.txt` }, within)).toBe(SandboxCrossing.None)
    }
  })
})

describe('sandboxCrossing: writes', () => {
  it.each([
    ['Write', { file_path: `${ROOT}/CHANGELOG.md` }],
    ['Edit', { file_path: 'src/retry.ts' }],
    ['MultiEdit', { file_path: '/Users/me/src/shared-lib/index.ts' }],
    ['NotebookEdit', { notebook_path: `${ROOT}/analysis.ipynb` }],
  ])("doesn't ask %s inside the root or a read-write grant", (toolName, input) => {
    expect(crossing(toolName, input)).toBe(SandboxCrossing.None)
  })

  it.each([
    ['in a read-only grant', '/Users/me/notes/staging.md'],
    ['elsewhere in the home folder', '/Users/me/.zshrc'],
    ['outside the home folder', '/etc/hosts'],
    ['in the temporary folder', '/tmp/out.txt'],
  ])('asks to write %s', (_what, path) => {
    expect(crossing('Write', { file_path: path })).toBe(SandboxCrossing.Boundary)
    expect(crossing('Edit', { file_path: path })).toBe(SandboxCrossing.Boundary)
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
    expect(crossing('WebSearch', { query: 'exponential backoff' }, scope({ grants: NO_GRANTS }))).toBe(
      SandboxCrossing.None,
    )
  })
})

describe('sandboxCrossing: running outside the sandbox', () => {
  it('knows the request by its input, whatever the tool or the command', () => {
    expect(isSandboxOverride({ command: 'docker compose up -d', dangerouslyDisableSandbox: true })).toBe(true)
    expect(isSandboxOverride({ command: 'docker compose up -d', dangerouslyDisableSandbox: false })).toBe(false)
    expect(isSandboxOverride({ command: 'docker compose up -d', dangerouslyDisableSandbox: 'true' })).toBe(false)
    expect(isSandboxOverride({ command: 'docker compose up -d' })).toBe(false)
    expect(crossing('Bash', { command: `ls ${ROOT}`, dangerouslyDisableSandbox: true })).toBe(SandboxCrossing.Override)
  })

  it('lets other commands go: the sandbox bounds them', () => {
    expect(crossing('Bash', { command: 'cat /Users/me/.ssh/id_rsa' })).toBe(SandboxCrossing.None)
    expect(crossing('Monitor', { command: 'npm run dev' })).toBe(SandboxCrossing.None)
    expect(crossing(`mcp__${GLADE_SERVER}__set_status`, { status: 'Working.' })).toBe(SandboxCrossing.None)
  })
})

describe('toolCallVerdict', () => {
  const plain = { mcpServer: null, matchedAskRule: false }
  const decide = (
    toolName: string,
    input: ToolInput,
    permissionMode: PermissionMode,
    sandbox: SandboxScope | null = scope(),
    extra: { matchedAskRule?: boolean } = {},
  ): PermissionVerdict =>
    toolCallVerdict({ ...plain, ...extra, toolName, input }, { permissionMode, gladeServers: [GLADE_SERVER], sandbox })

  const MODES = [PermissionMode.AllowAll, PermissionMode.AskBeforeEdits]

  it.each(MODES)('asks about every boundary crossing in %s', (mode) => {
    expect(decide('Read', { file_path: '/Users/me/Documents/taxes.pdf' }, mode)).toBe(PermissionVerdict.Ask)
    expect(decide('Write', { file_path: '/Users/me/notes/a.md' }, mode)).toBe(PermissionVerdict.Ask)
    expect(decide('WebFetch', { url: 'https://www.example.org/' }, mode)).toBe(PermissionVerdict.Ask)
    expect(decide('SandboxNetworkAccess', { host: 'www.example.org' }, mode)).toBe(PermissionVerdict.Ask)
  })

  it.each(MODES)("doesn't ask about reads inside the bounds, or outside the home folder, in %s", (mode) => {
    expect(decide('Read', { file_path: '/etc/hosts' }, mode)).toBe(PermissionVerdict.Allow)
    expect(decide('Read', { file_path: '/Users/me/notes/a.md' }, mode)).toBe(PermissionVerdict.Allow)
    expect(decide('WebFetch', { url: 'https://registry.npmjs.org/' }, mode)).toBe(PermissionVerdict.Allow)
    expect(decide('WebSearch', { query: 'backoff' }, mode)).toBe(PermissionVerdict.Allow)
  })

  it.each(MODES)(
    'asks about running outside the sandbox in %s, even when a rule or Allow all would allow it',
    (mode) => {
      const input = { command: 'docker compose up -d', dangerouslyDisableSandbox: true }
      expect(decide('Bash', input, mode)).toBe(PermissionVerdict.Ask)
      expect(decide('Bash', input, mode, scope(), { matchedAskRule: true })).toBe(PermissionVerdict.Ask)
    },
  )

  it.each(MODES)('refuses running outside a sandbox that couldn’t start, without asking, in %s', (mode) => {
    const input = { command: 'npm test', dangerouslyDisableSandbox: true }
    expect(decide('Bash', input, mode, scope({ failed: true }))).toBe(PermissionVerdict.Refuse)
    // Everything else is decided as before.
    expect(decide('Bash', { command: 'npm test' }, mode, scope({ failed: true }))).toBe(
      mode === PermissionMode.AllowAll ? PermissionVerdict.Allow : PermissionVerdict.Ask,
    )
  })

  it('lets everything else inside the bounds go in Allow all, the calls acceptEdits would ask about included', () => {
    const mode = PermissionMode.AllowAll
    expect(decide('Bash', { command: 'npm test' }, mode)).toBe(PermissionVerdict.Allow)
    expect(decide('Write', { file_path: `${ROOT}/a.md` }, mode)).toBe(PermissionVerdict.Allow)
    expect(decide('mcp__github__create_issue', {}, mode)).toBe(PermissionVerdict.Allow)
    expect(decide('Edit', { file_path: `${ROOT}/a.md` }, mode, scope(), { matchedAskRule: true })).toBe(
      PermissionVerdict.Allow,
    )
  })

  it('asks in the ask mode about what it always has', () => {
    const mode = PermissionMode.AskBeforeEdits
    expect(decide('Bash', { command: 'npm test' }, mode)).toBe(PermissionVerdict.Ask)
    expect(decide('Write', { file_path: `${ROOT}/a.md` }, mode)).toBe(PermissionVerdict.Ask)
    expect(decide('Read', { file_path: `${ROOT}/a.md` }, mode)).toBe(PermissionVerdict.Allow)
  })

  it('with the sandbox off, decides as before: Allow all allows everything, the ask mode its own rules', () => {
    const outside = { file_path: '/Users/me/Documents/taxes.pdf' }
    const override = { command: 'npm test', dangerouslyDisableSandbox: true }
    expect(decide('Read', outside, PermissionMode.AllowAll, null)).toBe(PermissionVerdict.Allow)
    expect(decide('Bash', override, PermissionMode.AllowAll, null)).toBe(PermissionVerdict.Allow)
    expect(decide('Read', outside, PermissionMode.AskBeforeEdits, null)).toBe(PermissionVerdict.Allow)
    expect(decide('WebFetch', { url: 'https://www.example.org/' }, PermissionMode.AskBeforeEdits, null)).toBe(
      PermissionVerdict.Allow,
    )
    expect(decide('Bash', override, PermissionMode.AskBeforeEdits, null)).toBe(PermissionVerdict.Ask)
  })
})
