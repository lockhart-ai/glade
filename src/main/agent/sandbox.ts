/**
 * The agent sandbox's settings (#445, `docs/sdk-notes.md` §15): pure functions from a task's workspace root, its
 * permission mode and its grants to what its session's sandbox and permission rules are.
 *
 * - **At start** (`sandboxStartSettings`), a session gets only what no grant ever changes: Seatbelt on, failing every
 *   command rather than running it unsandboxed when it can't start; reads of the home folder, `/Users` and `/Volumes`
 *   denied but for the workspace root, which is the one folder it may write; no domain; the credential files, and
 *   Glade's own data folder, denied to commands and file tools alike; every switch that would loosen the sandbox set
 *   off, so the user's own Claude Code settings can't turn one on underneath; the control endpoint's variables kept
 *   from commands; and the ask rule that makes running outside the sandbox always ask. Whatever the start says, a
 *   later `applyFlagSettings` can't take back, so it never carries a grant.
 * - **The overlay** (`sandboxOverlay`), applied with `applyFlagSettings` straight after start and whenever the mode or
 *   the grants change: the same fixed parts, `autoAllowBashIfSandboxed` for the mode, and the grants: every granted
 *   folder readable by commands, the read-write ones writable but for the files in them that run code
 *   (`protectedWrites`); and domains as `WebFetch(domain:…)` rules in `permissions.allow`, which is the only place
 *   they reach commands too (never `allowedTools`). A grant of a single file (`file`) is that file's own path.
 * - **The file tools get no grant from the settings** (#514): no additional directory and no `Read` or `Edit` allow
 *   rule. Claude Code would follow a granted folder that a command swapped for a link; Glade decides every file-tool
 *   call outside the root itself instead (`../permissions/sandbox-classify`).
 *
 * `autoAllowBashIfSandboxed` is in the overlay only, never the start: left out at start, the SDK's default (on) applies
 * until the overlay lands, and the overlay's value then holds either way (probed, §15: in `default` mode a command
 * ran unasked before the overlay, asked once the overlay said false, and ran unasked again once it said true). The
 * runner holds a session's messages until the overlay is applied, and never runs a session that won't take it.
 *
 * A grant that could widen the sandbox past what it names never reaches the settings (`usableGrants`): a folder that
 * isn't an absolute path, is `/`, or has a glob character (sandbox paths and rule contents are patterns), and a
 * domain that isn't a host name, with an optional leading `*.`.
 */
import { homedir } from 'node:os'
import { posix } from 'node:path'
import { PermissionMode } from '../../shared/domain'
import { hostKind, HostKind } from '../../shared/hosts'
import { isMcpServerKey } from '../../shared/mcpServers'
import { permissionRuleString } from '../../shared/permissions'
import { FolderAccess, type OtherAgents } from '../../shared/sandbox'
import type { SandboxCredentialFile, SandboxFlagSettings, SandboxSettings, SettingsPermissions } from './backend'
import { domainRuleString, isBareHost, isInside, readRuleContent, SANDBOX_OVERRIDE_ASK_RULE } from './sandbox-requests'

/** A folder the agent was granted, by absolute path; or one file, and nothing beside it (`file`). */
export interface SandboxFolderGrant {
  readonly path: string
  readonly access: FolderAccess
  /** Set when the grant is for that one file. Left out for a folder. */
  readonly file?: true
}

/**
 * Everything granted to a task beyond its workspace root: folders, and domains (`registry.npmjs.org`, `*.acme.dev`).
 * And what's granted beyond the sandbox altogether (#515), none of which goes into the sandbox's settings: Glade
 * holds the session to them itself (`../permissions/sandbox-classify`).
 */
export interface SandboxGrants {
  readonly folders: readonly SandboxFolderGrant[]
  readonly domains: readonly string[]
  /** The MCP servers granted, each by its key (`../../shared/mcpServers`). None when left out. */
  readonly servers?: readonly string[]
  /** The other agents granted. None when left out. */
  readonly agents?: readonly OtherAgents[]
}

/** Nothing granted: what a task has until it, its workspace or Glade is granted something (`../sandbox/grants`). */
export const NO_GRANTS: SandboxGrants = { folders: [], domains: [], servers: [], agents: [] }

/** Why a grant can't go into the sandbox's settings. */
export enum GrantProblem {
  /** A folder that isn't an absolute path (a relative or empty one). */
  NotAbsolute = 'not_absolute',
  /** A folder that is `/`, or comes to it once its `..`s are followed: it would grant everything. */
  WholeDisk = 'whole_disk',
  /** A folder with a glob character (`*`, `?`, `[`, `]`, `{`, `}` or a backslash): it would match more than itself. */
  Pattern = 'pattern',
  /** An MCP server whose key a tool's name couldn't carry. */
  NotAServer = 'not_a_server',
  /** A domain that isn't a host name, with an optional leading `*.`. */
  NotAHost = 'not_a_host',
}

/** A grant left out of the sandbox's settings, and why. */
export interface RejectedGrant {
  /** The folder's path or the domain, as granted. */
  readonly value: string
  readonly problem: GrantProblem
}

/** Grants sorted into those the sandbox's settings can take, their folders normalized, and those they can't. */
export interface CheckedGrants {
  readonly grants: SandboxGrants
  readonly rejected: readonly RejectedGrant[]
}

/** The characters sandbox paths and permission rules read as a pattern. */
const GLOB_CHARACTERS = /[*?[\]{}\\]/

/** What's wrong with a folder as a grant, or null when it can be one. */
function folderProblem(path: string): GrantProblem | null {
  if (!path.startsWith('/')) return GrantProblem.NotAbsolute
  if (GLOB_CHARACTERS.test(path)) return GrantProblem.Pattern
  return sandboxFolder(path) === '/' ? GrantProblem.WholeDisk : null
}

/**
 * Whether a domain can be granted: a bare host name, or one under a leading `*.`. Never an address in another spelling
 * than its four decimal parts (`2130706433` is `127.0.0.1`): a grant must read as what it opens (`../../shared/hosts`).
 */
function isGrantableDomain(domain: string): boolean {
  return isBareHost(domain.startsWith('*.') ? domain.slice(2) : domain) && hostKind(domain) !== HostKind.Numeric
}

/**
 * The grants the sandbox's settings can take (see the module comment), each folder normalized, and the ones left out,
 * for whoever applies them to log.
 */
export function usableGrants(grants: SandboxGrants): CheckedGrants {
  const rejected: RejectedGrant[] = []
  const folders = grants.folders.flatMap(({ path, access, file }): SandboxFolderGrant[] => {
    const problem = folderProblem(path)
    if (problem === null) return [{ path: sandboxFolder(path), access, ...(file === true ? { file } : {}) }]
    rejected.push({ value: path, problem })
    return []
  })
  const domains = grants.domains.filter((domain) => {
    if (isGrantableDomain(domain)) return true
    rejected.push({ value: domain, problem: GrantProblem.NotAHost })
    return false
  })
  const servers = (grants.servers ?? []).filter((server) => {
    if (isMcpServerKey(server)) return true
    rejected.push({ value: server, problem: GrantProblem.NotAServer })
    return false
  })
  const outside = {
    ...(grants.servers === undefined ? {} : { servers }),
    ...(grants.agents === undefined ? {} : { agents: grants.agents }),
  }
  return { grants: { folders, domains, ...outside }, rejected }
}

/** Whether a credential path is a folder (everything in it) or a single file. */
export enum CredentialKind {
  Folder = 'folder',
  File = 'file',
}

/** A file or folder in the home folder that holds credentials. */
export interface CredentialPath {
  /** Its path from the home folder, e.g. `.ssh`. */
  readonly path: string
  readonly kind: CredentialKind
}

/**
 * The credential files and folders no command or file tool may read or write, even inside a granted folder, and even
 * when the home folder itself is granted: keys, cloud and registry logins, and the keychains.
 */
export const CREDENTIAL_PATHS: readonly CredentialPath[] = [
  { path: '.ssh', kind: CredentialKind.Folder },
  { path: '.aws', kind: CredentialKind.Folder },
  { path: '.gnupg', kind: CredentialKind.Folder },
  { path: '.config/gh', kind: CredentialKind.Folder },
  { path: '.config/gcloud', kind: CredentialKind.Folder },
  { path: '.azure', kind: CredentialKind.Folder },
  { path: '.kube', kind: CredentialKind.Folder },
  { path: 'Library/Keychains', kind: CredentialKind.Folder },
  { path: '.netrc', kind: CredentialKind.File },
  { path: '.git-credentials', kind: CredentialKind.File },
  { path: '.docker/config.json', kind: CredentialKind.File },
  // Added by the phase's security review (#514).
  // Claude Code's own state: MCP servers' headers and tokens, and Glade's control token once its command was run.
  { path: '.claude.json', kind: CredentialKind.File },
  // Registry logins. Not `~/.npmrc` or `~/.pypirc` (#515): they hold a registry's settings as often as its token, and
  // tools need them, so each is granted like any other file in the home folder, by itself.
  { path: '.cargo/credentials', kind: CredentialKind.File },
  { path: '.cargo/credentials.toml', kind: CredentialKind.File },
  { path: '.gem/credentials', kind: CredentialKind.File },
  { path: '.config/git/credentials', kind: CredentialKind.File },
  // Password managers' and other cloud tools' tokens.
  { path: '.config/op', kind: CredentialKind.Folder },
  { path: '.oci', kind: CredentialKind.Folder },
  { path: '.config/doctl', kind: CredentialKind.Folder },
  { path: '.config/hcloud', kind: CredentialKind.Folder },
  { path: '.config/heroku', kind: CredentialKind.Folder },
  { path: '.config/flyctl', kind: CredentialKind.Folder },
  { path: '.fly', kind: CredentialKind.Folder },
  { path: '.config/vercel', kind: CredentialKind.Folder },
  { path: 'Library/Application Support/com.vercel.cli', kind: CredentialKind.Folder },
  { path: '.config/netlify', kind: CredentialKind.Folder },
  { path: 'Library/Preferences/netlify', kind: CredentialKind.Folder },
  { path: '.config/.wrangler', kind: CredentialKind.Folder },
  { path: '.wrangler', kind: CredentialKind.Folder },
  { path: '.config/configstore', kind: CredentialKind.Folder },
  { path: '.terraform.d/credentials.tfrc.json', kind: CredentialKind.File },
  { path: '.pulumi/credentials.json', kind: CredentialKind.File },
  { path: '.databrickscfg', kind: CredentialKind.File },
  { path: '.config/rclone', kind: CredentialKind.Folder },
  { path: '.boto', kind: CredentialKind.File },
  { path: '.s3cfg', kind: CredentialKind.File },
]

/**
 * The files that run code, by name, wherever they are: git's and ripgrep's config, an MCP config, and the shells'
 * startup files. Claude Code's own list for a sandboxed command (in the bundled binary, 2.1.283), and the shell startup
 * files it leaves out. A file tool's write to one always asks (`../permissions/sandbox-classify`), and a sandboxed
 * command can't write one inside a folder granted read-write (`protectedWrites`).
 */
export const PROTECTED_FILES: readonly string[] = [
  '.mcp.json',
  '.gitconfig',
  '.gitmodules',
  '.ripgreprc',
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.profile',
  '.zshrc',
  '.zprofile',
  '.zshenv',
  '.zlogin',
]

/** The folders whose files run code, by name, wherever they are: a file tool's write into one always asks. */
export const PROTECTED_FOLDERS: readonly string[] = ['.git', '.claude', '.vscode', '.idea']

/**
 * The folders a sandboxed command can't write into inside a granted folder, as under the workspace root: the editors'
 * (their tasks run code), and of a repository's own folder and Claude Code's only the parts that run code, so a
 * command can still commit in a granted repository, or work in a worktree under its `.claude`.
 */
const COMMAND_PROTECTED_FOLDERS: readonly string[] = [
  '.vscode',
  '.idea',
  '.git/hooks',
  '.claude/commands',
  '.claude/agents',
  '.claude/skills',
  '.claude/hooks',
]

/** The files a sandboxed command can't write inside a granted folder: the ones that run code, and the configs that name some. */
const COMMAND_PROTECTED_FILES: readonly string[] = [
  ...PROTECTED_FILES,
  '.git/config',
  '.claude/settings.json',
  '.claude/settings.local.json',
]

/**
 * The paths a sandboxed command may not write inside a folder granted read-write (`sandbox.filesystem.denyWrite`):
 * the files and folders that run code (#514). Claude Code denies them under the workspace root by itself, and nowhere
 * else: in a granted folder a command could write `.zshrc` or `.git/hooks/pre-commit` (probed, `docs/sdk-notes.md`
 * §15). Each is denied twice, in the two forms Claude Code's own list takes for the root: by its path at the folder's
 * top, and by a pattern (two stars for any folders between) for the same name at any depth under it.
 */
export function protectedWrites(folder: string): string[] {
  return [
    ...COMMAND_PROTECTED_FILES.flatMap((name) => [`${folder}/${name}`, `${folder}/**/${name}`]),
    ...COMMAND_PROTECTED_FOLDERS.flatMap((name) => [`${folder}/${name}`, `${folder}/**/${name}/**`]),
    // A granted folder that is itself a repository's own folder, or Claude Code's: what's protected directly in it.
    ...[...COMMAND_PROTECTED_FILES, ...COMMAND_PROTECTED_FOLDERS].flatMap((name) => {
      const [parent, child] = name.split('/')
      return child !== undefined && folder.endsWith(`/${parent ?? ''}`) ? [`${folder}/${child}`] : []
    }),
  ]
}

/**
 * Whether a sandboxed command is kept from writing `path` wherever it is granted (`protectedWrites`): it's one of the
 * files that run code, or in one of the folders of them. `path` is lower-cased, as a path's key is.
 */
export function isProtectedWrite(path: string): boolean {
  const inside = `${path}/`
  return (
    COMMAND_PROTECTED_FILES.some((name) => path.endsWith(`/${name}`)) ||
    COMMAND_PROTECTED_FOLDERS.some((name) => inside.includes(`/${name}/`))
  )
}

/** The folders whose reads are denied but for the workspace root and granted folders: the home folder is added. */
export const DENIED_READ_ROOTS: readonly string[] = ['/Users', '/Volumes']

/** A folder as the sandbox lists it: absolute, normalized, with no trailing slash (`/` stays `/`). */
export function sandboxFolder(path: string): string {
  const normalized = posix.normalize(path)
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
}

/** The credential paths, absolute, under `home`. */
export function credentialPaths(home: string = homedir()): CredentialPath[] {
  const base = sandboxFolder(home)
  return CREDENTIAL_PATHS.map(({ path, kind }) => ({ path: posix.join(base, path), kind }))
}

/** The rules that keep the file tools out of paths nothing opens: `Read` and `Edit` of each, a folder's contents too. */
function denyRules(paths: readonly CredentialPath[]): string[] {
  return paths.flatMap(({ path, kind }) => {
    const content = kind === CredentialKind.Folder ? readRuleContent(path) : `/${path}`
    return ['Read', 'Edit'].map((toolName) => permissionRuleString({ toolName, ruleContent: content }))
  })
}

/** The rules that keep the file tools out of the credential paths: `Read` and `Edit` of each, a folder's contents too. */
export function credentialDenyRules(home: string = homedir()): string[] {
  return denyRules(credentialPaths(home))
}

/**
 * Every path nothing opens, for a session in `root`: the credential paths, and the folders `denied` names (Glade's own
 * data folder: its database holds the grants, the settings and the control token), each as a folder and all in it. A
 * denied folder that holds the root is left out: the root is always the agent's to use.
 */
export function fixedDenies(root: string, home: string, denied: readonly string[]): CredentialPath[] {
  const folder = sandboxFolder(root)
  const folders = unique(denied.map(sandboxFolder)).filter((path) => !isInside(folder, path))
  return [...credentialPaths(home), ...folders.map((path) => ({ path, kind: CredentialKind.Folder }))]
}

/**
 * The variables no sandboxed command gets (`sandbox.credentials.envVars`): the control endpoint's URL and token
 * (`ControlEnv`, `../control/endpoint`), which are in the session's environment while agents may control Glade. With
 * them a command could call the control API as no task at all, once anything let it reach the loopback address (#514).
 * The session's own control tools don't use them.
 */
export const DENIED_ENV_VARS: readonly string[] = ['GLADE_CONTROL_URL', 'GLADE_CONTROL_TOKEN']

/**
 * Whether a sandboxed command runs without asking in a permission mode: in Allow all it does (the sandbox bounds it),
 * and in the ask mode every command asks, as it does unsandboxed.
 */
export function autoAllowBashIfSandboxed(mode: PermissionMode): boolean {
  switch (mode) {
    case PermissionMode.AllowAll:
      return true
    case PermissionMode.AskBeforeEdits:
      return false
  }
}

/** Each path once, in the order first given. */
function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)]
}

/** What the sandbox's settings are made for: the folders commands may use, and what stays shut inside them. */
interface SandboxParts {
  readonly home: string
  /** Every path nothing opens (`fixedDenies`). */
  readonly denies: readonly CredentialPath[]
  readonly allowRead: readonly string[]
  readonly allowWrite: readonly string[]
  /** The granted folders commands may write, in which the files that run code stay write-protected (`protectedWrites`). */
  readonly writableGrants: readonly string[]
}

/**
 * The sandbox's fixed parts, with the folders commands may read and write besides those denied. Every switch that
 * would loosen the sandbox is set, off, so one in the user's own Claude Code settings can't fall through under Glade's
 * (#514): Glade's are flag settings, which outrank the user's, the project's and the local ones for a single value.
 * Lists merge across the sources instead, so the empty ones here add nothing and take nothing away.
 */
function sandboxSettings({ home, denies, allowRead, allowWrite, writableGrants }: SandboxParts): SandboxSettings {
  const denied = denies.map(({ path }) => path)
  const files: SandboxCredentialFile[] = denied.map((path) => ({ path, mode: 'deny' }))
  return {
    enabled: true,
    failIfUnavailable: true,
    filesystem: {
      denyRead: [sandboxFolder(home), ...DENIED_READ_ROOTS],
      allowRead: unique(allowRead),
      allowWrite: unique(allowWrite),
      denyWrite: unique([...denied, ...writableGrants.flatMap(protectedWrites)]),
      disabled: false,
    },
    network: { allowedDomains: [], allowLocalBinding: false, allowAllUnixSockets: false, allowUnixSockets: [] },
    credentials: { files, envVars: DENIED_ENV_VARS.map((name) => ({ name, mode: 'deny' })) },
    allowAppleEvents: false,
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    ignoreViolations: {},
  }
}

/**
 * What a sandboxed session starts with (`AgentSessionOptions.flagSettings`): only the parts no grant changes, since a
 * later `applyFlagSettings` can't narrow them (`docs/sdk-notes.md` §15). The workspace root is the one folder commands
 * may read and write past the denied ones; no domain; the credential paths, and the folders `denied` names, shut to
 * commands and file tools; the switches that would loosen the sandbox set off; the control endpoint's variables kept
 * from commands; and the ask rule that makes running outside the sandbox always ask, in every mode, even when a task
 * rule or Allow all would let the command through.
 */
export function sandboxStartSettings(
  root: string,
  home: string = homedir(),
  denied: readonly string[] = [],
): SandboxFlagSettings {
  const folder = sandboxFolder(root)
  const denies = fixedDenies(root, home, denied)
  return {
    sandbox: sandboxSettings({ home, denies, allowRead: [folder], allowWrite: [folder], writableGrants: [] }),
    permissions: { ask: [SANDBOX_OVERRIDE_ASK_RULE], deny: denyRules(denies) },
  }
}

/**
 * The whole overlay a sandboxed session's `applyFlagSettings` takes (`docs/sdk-notes.md` §15): the fixed parts again,
 * `autoAllowBashIfSandboxed` for `mode`, and `grants`. Commands may read the root and every granted folder, and write
 * the root and the read-write ones, a single file by its own path; inside a folder granted read-write, the files that
 * run code stay write-protected (`protectedWrites`). Domains are `WebFetch(domain:…)` rules in `permissions.allow`,
 * which Claude Code merges into the sandbox's network allowlist too. The credential paths stay denied whatever is
 * granted. A grant the settings can't take is left out (`usableGrants`).
 *
 * **The file tools are told of no grant** (#514): no additional directory, and no `Read` or `Edit` allow rule. Claude
 * Code resolves an additional directory itself, and follows one swapped for a link to another folder; so it asks Glade
 * about every file-tool call outside the root instead, and Glade compares where the call's path really is with the
 * grant as kept (`../permissions/sandbox-classify`).
 */
export function sandboxOverlay(
  root: string,
  mode: PermissionMode,
  grants: SandboxGrants,
  home: string = homedir(),
  denied: readonly string[] = [],
): SandboxFlagSettings {
  const folder = sandboxFolder(root)
  const { folders: granted, domains } = usableGrants(grants).grants
  const paths = (grants: readonly SandboxFolderGrant[]): string[] => unique(grants.map(({ path }) => path))
  const writable = granted.filter(({ access }) => access === FolderAccess.ReadWrite)
  const denies = fixedDenies(root, home, denied)
  const permissions: SettingsPermissions = {
    allow: unique(domains).map(domainRuleString),
    ask: [SANDBOX_OVERRIDE_ASK_RULE],
    deny: denyRules(denies),
  }
  return {
    sandbox: {
      ...sandboxSettings({
        home,
        denies,
        allowRead: [folder, ...paths(granted)],
        allowWrite: [folder, ...paths(writable)],
        writableGrants: paths(writable.filter(({ file }) => file !== true)),
      }),
      autoAllowBashIfSandboxed: autoAllowBashIfSandboxed(mode),
    },
    permissions,
  }
}
