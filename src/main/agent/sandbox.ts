/**
 * The agent sandbox's settings (#445, `docs/sdk-notes.md` §15): pure functions from a task's workspace root, its
 * permission mode and its grants to what its session's sandbox and permission rules are.
 *
 * - **At start** (`sandboxStartSettings`), a session gets only what no grant ever changes: Seatbelt on, failing every
 *   command rather than running it unsandboxed when it can't start; reads of the home folder, `/Users` and `/Volumes`
 *   denied but for the workspace root, which is the one folder it may write; no domain; the credential files denied,
 *   to commands and file tools alike; and the ask rule that makes running outside the sandbox always ask. Whatever the
 *   start says, a later `applyFlagSettings` can't take back, so it never carries a grant.
 * - **The overlay** (`sandboxOverlay`), applied with `applyFlagSettings` straight after start and whenever the mode or
 *   the grants change: the same fixed parts, `autoAllowBashIfSandboxed` for the mode, and the grants: every granted
 *   folder readable by commands, the read-write ones writable; for the file tools, read-only folders as `Read` rules and
 *   read-write ones as additional directories; and domains as `WebFetch(domain:…)` rules in `permissions.allow`, which
 *   is the only place they reach commands too (never `allowedTools`).
 *
 * `autoAllowBashIfSandboxed` is in the overlay only, never the start: whether the overlay's value would override the
 * start's for a boolean isn't probed (§15 probed lists only), and with it left out at start, the SDK's default (on)
 * applies only until the overlay lands, before the session's first message.
 */
import { homedir } from 'node:os'
import { posix } from 'node:path'
import { PermissionMode } from '../../shared/domain'
import { permissionRuleString } from '../../shared/permissions'
import type { SandboxCredentialFile, SandboxFlagSettings, SandboxSettings, SettingsPermissions } from './backend'
import { domainRuleString, readRuleContent, SANDBOX_OVERRIDE_ASK_RULE } from './sandbox-requests'

/** How much of a granted folder the agent may use. */
export enum SandboxAccess {
  Read = 'read',
  ReadWrite = 'read_write',
}

/** A folder the agent was granted, by absolute path. */
export interface SandboxFolderGrant {
  readonly path: string
  readonly access: SandboxAccess
}

/** Everything granted to a task beyond its workspace root: folders, and domains (`registry.npmjs.org`, `*.acme.dev`). */
export interface SandboxGrants {
  readonly folders: readonly SandboxFolderGrant[]
  readonly domains: readonly string[]
}

/** Nothing granted: what every task has until P15-04's grants. */
export const NO_GRANTS: SandboxGrants = { folders: [], domains: [] }

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
]

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

/** The rules that keep the file tools out of the credential paths: `Read` and `Edit` of each, a folder's contents too. */
export function credentialDenyRules(home: string = homedir()): string[] {
  return credentialPaths(home).flatMap(({ path, kind }) => {
    const content = kind === CredentialKind.Folder ? readRuleContent(path) : `/${path}`
    return ['Read', 'Edit'].map((toolName) => permissionRuleString({ toolName, ruleContent: content }))
  })
}

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

/** The sandbox's fixed parts, with the folders commands may read and write besides those denied. */
function sandboxSettings(home: string, allowRead: readonly string[], allowWrite: readonly string[]): SandboxSettings {
  const credentials = credentialPaths(home).map(({ path }) => path)
  const files: SandboxCredentialFile[] = credentials.map((path) => ({ path, mode: 'deny' }))
  return {
    enabled: true,
    failIfUnavailable: true,
    filesystem: {
      denyRead: [sandboxFolder(home), ...DENIED_READ_ROOTS],
      allowRead: unique(allowRead),
      allowWrite: unique(allowWrite),
      denyWrite: credentials,
    },
    network: { allowedDomains: [] },
    credentials: { files },
  }
}

/**
 * What a sandboxed session starts with (`AgentSessionOptions.flagSettings`): only the parts no grant changes, since a
 * later `applyFlagSettings` can't narrow them (`docs/sdk-notes.md` §15). The workspace root is the one folder commands
 * may read and write past the denied ones; no domain; the credential paths denied to commands and file tools; and the
 * ask rule that makes running outside the sandbox always ask, in every mode, even when a task rule or Allow all would
 * let the command through.
 */
export function sandboxStartSettings(root: string, home: string = homedir()): SandboxFlagSettings {
  const folder = sandboxFolder(root)
  return {
    sandbox: sandboxSettings(home, [folder], [folder]),
    permissions: { ask: [SANDBOX_OVERRIDE_ASK_RULE], deny: credentialDenyRules(home) },
  }
}

/**
 * The whole overlay a sandboxed session's `applyFlagSettings` takes (`docs/sdk-notes.md` §15): the fixed parts again,
 * `autoAllowBashIfSandboxed` for `mode`, and `grants`. Commands may read the root and every granted folder, and write
 * the root and the read-write ones. The file tools may read the read-only folders (`Read(//<folder>/**)` rules) and use
 * the read-write ones (`additionalDirectories`). Domains are `WebFetch(domain:…)` rules in `permissions.allow`, which
 * Claude Code merges into the sandbox's network allowlist too. The credential paths stay denied whatever is granted.
 */
export function sandboxOverlay(
  root: string,
  mode: PermissionMode,
  grants: SandboxGrants,
  home: string = homedir(),
): SandboxFlagSettings {
  const folder = sandboxFolder(root)
  const granted = grants.folders.map(({ path, access }) => ({ path: sandboxFolder(path), access }))
  const readOnly = unique(granted.filter(({ access }) => access === SandboxAccess.Read).map(({ path }) => path))
  const readWrite = unique(granted.filter(({ access }) => access === SandboxAccess.ReadWrite).map(({ path }) => path))
  const permissions: SettingsPermissions = {
    allow: [
      ...readOnly.map((path) => permissionRuleString({ toolName: 'Read', ruleContent: readRuleContent(path) })),
      ...unique(grants.domains).map(domainRuleString),
    ],
    ask: [SANDBOX_OVERRIDE_ASK_RULE],
    deny: credentialDenyRules(home),
    additionalDirectories: readWrite,
  }
  return {
    sandbox: {
      ...sandboxSettings(home, [folder, ...granted.map(({ path }) => path)], [folder, ...readWrite]),
      autoAllowBashIfSandboxed: autoAllowBashIfSandboxed(mode),
    },
    permissions,
  }
}
