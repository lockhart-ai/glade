/**
 * Which of a sandboxed session's tool calls ask, go ahead or are refused (#445, `docs/sdk-notes.md` §15), of the calls
 * Claude Code asks Glade about (`canUseTool`). The sandbox only bounds commands; the file tools and `WebFetch` run
 * outside it, so they're held to the same bounds here.
 *
 * - **Crossing the bounds asks, in either mode:** a read under the home folder, `/Users`, `/Volumes` or
 *   `/System/Volumes` outside the workspace root and the granted folders; a write outside the root and the read-write
 *   folders; `WebFetch` to a domain that isn't granted; and a command's connection to a host that isn't
 *   (`SandboxNetworkAccess`). Reads elsewhere (`/etc/hosts`, `/usr/…`) go ahead, as do reads inside the bounds.
 * - **Paths are compared by where they really are** (`./canonical-path`): a symbolic link, the data volume's alias,
 *   another case or `~` is the folder it leads to. A path that can't be resolved asks.
 * - **A granted folder is the path that was granted, and nothing it later leads to.** Grants are kept by where the
 *   folder really was when it was granted (`../sandbox/grants`), and compared here as kept: only the call's own path is
 *   resolved. So a granted folder swapped for a link to another opens nothing new: a call through it leads elsewhere,
 *   and asks. A single file's grant (`SandboxFolderGrant.file`) covers that path alone, not what's beside it.
 * - **A credential path is refused**, read or write, whatever is granted and however it's spelled (`CREDENTIAL_PATHS`).
 * - **Running a command outside the sandbox asks**, every time (`dangerouslyDisableSandbox` set to anything but false),
 *   and is refused without asking once the sandbox couldn't start in the session.
 * - **A write inside the bounds that Claude Code still asked about asks.** In Allow all the session runs `acceptEdits`,
 *   which lets edits inside the bounds through by itself: one that reaches Glade was held back by Claude Code's own
 *   check of the files that run code (`.mcp.json`, `.claude/`, `.git/`, shell startup files), or by a user's ask rule.
 *   In the ask mode every write asks as it always has, unless the task was granted the whole tool (Allow for this
 *   task): that rule is kept from the session, which would take it for every folder, and decided here instead, for
 *   writes inside the bounds that aren't to one of those files.
 * - **Everything else:** in Allow all it goes ahead; in the ask mode, `./classify` decides it, as with the sandbox off.
 */
import { PermissionMode, type PermissionRule, type ToolInput } from '../../shared/domain'
import { FolderAccess } from '../../shared/sandbox'
import { credentialPaths, DENIED_READ_ROOTS, sandboxFolder, usableGrants } from '../agent/sandbox'
import type { SandboxFolderGrant, SandboxGrants } from '../agent/sandbox'
import { hostMatches, SANDBOX_NETWORK_TOOL } from '../agent/sandbox-requests'
import { absolutePath, canonicalKey, keyInside, NATIVE_FS, pathKey, type PathFs } from './canonical-path'
import { permissionVerdict, PermissionVerdict, type ClassifiedCall } from './classify'

/** How a tool call stands to the agent sandbox's bounds. */
export enum SandboxCrossing {
  /** It stays inside them, or isn't something the sandbox bounds. */
  None = 'none',
  /** It reaches a folder or domain that isn't granted. */
  Boundary = 'boundary',
  /** It writes, inside the bounds, a file Claude Code's own checks hold back: one that runs code, or an ask rule's. */
  Protected = 'protected',
  /** It reads or writes a credential path, which no grant opens. */
  Credential = 'credential',
  /** It asks to run a command outside the sandbox (`dangerouslyDisableSandbox`). */
  Override = 'override',
}

/** A call as deciding it against the sandbox reads it: its tool and input. */
export interface SandboxedCall {
  readonly toolName: string
  readonly input: ToolInput
}

/** The tools that only read, by the input field naming what they read; a search with no path searches the root. */
const READ_PATHS: Readonly<Record<string, string>> = {
  Read: 'file_path',
  NotebookRead: 'notebook_path',
  LS: 'path',
  Grep: 'path',
  Glob: 'path',
}

/** The file tools that write, by the input field naming the file. */
const WRITE_PATHS: Readonly<Record<string, string>> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
}

/**
 * The folders the file tools' reads are bounded in, besides the home folder: the sandbox's own, and macOS's other
 * names for volumes. (Commands aren't denied `/System/Volumes`: the system itself runs from there.)
 */
const BOUNDED_ROOTS: readonly string[] = [...DENIED_READ_ROOTS, '/System/Volumes']

/**
 * The folders and files whose contents run code, by name, wherever they are: what Claude Code's own check holds a
 * write to back for (its list in the bundled binary, and the shell startup files it leaves out).
 */
const CODE_FOLDERS: ReadonlySet<string> = new Set(['.git', '.claude', '.vscode', '.idea'])
const CODE_FILES: ReadonlySet<string> = new Set([
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
])

/** Whether the path with this key is one of the files that run code, or in one of the folders that do. */
function runsCode(key: string): boolean {
  const parts = key.split('/')
  return CODE_FILES.has(parts.at(-1) ?? '') || parts.some((part) => CODE_FOLDERS.has(part))
}

/** The input field naming the path a tool acts on, for one of the tools in `fields`; undefined for any other tool. */
function pathField(fields: Readonly<Record<string, string>>, toolName: string): string | undefined {
  return Object.hasOwn(fields, toolName) ? fields[toolName] : undefined
}

/** Whether a tool writes files. */
export function isWriteTool(toolName: string): boolean {
  return pathField(WRITE_PATHS, toolName) !== undefined
}

/**
 * Whether a task's rule must be kept from a sandboxed session and decided by Glade instead: a rule for a whole tool the
 * sandbox bounds (`Write`, `Edit`, `Read`, `WebFetch`, …), which Claude Code would take for every folder and domain.
 */
export function isUnboundedRule(rule: PermissionRule): boolean {
  const whole = rule.ruleContent === undefined || rule.ruleContent.trim() === ''
  const bounded = pathField({ ...READ_PATHS, ...WRITE_PATHS }, rule.toolName) !== undefined
  return whole && (bounded || rule.toolName === 'WebFetch')
}

/**
 * The sandbox's bounds, as deciding a call compares against them: each folder by its key (`./canonical-path`). Built
 * once for a session, and again when its grants change, so deciding a call resolves only the call's own path.
 */
export interface SandboxBounds {
  /** The workspace root, as given: where a relative path is from. */
  readonly root: string
  /** The home folder, as given: what `~` is. */
  readonly home: string
  /** The folders the agent may read: the root and every granted folder. */
  readonly readable: readonly string[]
  /** The folders it may write: the root and the read-write grants. */
  readonly writable: readonly string[]
  /** The single files granted, each of which it may read: that path alone, and nothing beside it. */
  readonly readableFiles: readonly string[]
  /** The single files granted read-write. */
  readonly writableFiles: readonly string[]
  /** The folders its reads are bounded in: the home folder, `/Users`, `/Volumes` and `/System/Volumes`. */
  readonly bounded: readonly string[]
  /** The credential paths, which nothing opens. */
  readonly credentials: readonly string[]
  /** The domains granted. */
  readonly domains: readonly string[]
  readonly fs: PathFs
}

/** What the bounds are made from. */
export interface SandboxBoundsSource {
  readonly root: string
  readonly home: string
  readonly grants: SandboxGrants
  /** The file system paths are resolved through: the real one by default. */
  readonly fs?: PathFs
}

/** The sandbox's bounds for a workspace root and what's granted beyond it; a grant the sandbox can't take is left out. */
export function sandboxBounds({ root, home, grants, fs = NATIVE_FS }: SandboxBoundsSource): SandboxBounds {
  // A folder that can't be resolved is compared as written.
  const key = (folder: string): string => canonicalKey(sandboxFolder(folder), fs) ?? pathKey(sandboxFolder(folder))
  // A grant is compared as it's kept, never resolved again: what its path leads to now was never granted.
  const kept = (granted: readonly SandboxFolderGrant[]): string[] => granted.map(({ path }) => pathKey(path))
  const { folders: granted, domains } = usableGrants(grants).grants
  const folders = granted.filter(({ file }) => file !== true)
  const files = granted.filter(({ file }) => file === true)
  const readWrite = ({ access }: SandboxFolderGrant): boolean => access === FolderAccess.ReadWrite
  return {
    root: sandboxFolder(root),
    home: sandboxFolder(home),
    readable: [key(root), ...kept(folders)],
    writable: [key(root), ...kept(folders.filter(readWrite))],
    readableFiles: kept(files),
    writableFiles: kept(files.filter(readWrite)),
    bounded: [home, ...BOUNDED_ROOTS].map(key),
    credentials: credentialPaths(home).map(({ path }) => key(path)),
    domains,
    fs,
  }
}

/**
 * The key of the path a call's input names in `field`; undefined when it names none, null when it can't be resolved.
 */
function inputKey(input: ToolInput, field: string | undefined, bounds: SandboxBounds): string | null | undefined {
  if (field === undefined) return undefined
  const value = input[field]
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return canonicalKey(absolutePath(value, bounds.root, bounds.home), bounds.fs)
}

/** Whether the path with this key is in one of the folders with these keys. */
export function inAny(key: string, folders: readonly string[]): boolean {
  return folders.some((folder) => keyInside(key, folder))
}

/** Whether the agent may read the path with this key: it's in the root or a granted folder, or is a granted file. */
export function mayRead(key: string, bounds: Pick<SandboxBounds, 'readable' | 'readableFiles'>): boolean {
  return inAny(key, bounds.readable) || bounds.readableFiles.includes(key)
}

/** Whether the agent may write the path with this key: in the root or a read-write folder, or a read-write file. */
export function mayWrite(key: string, bounds: Pick<SandboxBounds, 'writable' | 'writableFiles'>): boolean {
  return inAny(key, bounds.writable) || bounds.writableFiles.includes(key)
}

/** The path a file tool's call names, and what the tool does with it. */
export interface FileToolPath {
  /** The path, absolute: `~` is the home folder, and a relative path is from the workspace root. */
  readonly path: string
  /** What a grant for it would be: read-only for a tool that reads, read-write for one that writes. */
  readonly access: FolderAccess
}

/** The path a file tool's call reads or writes; null for any other tool, and for a call that names none. */
export function fileToolPath(call: SandboxedCall, bounds: Pick<SandboxBounds, 'root' | 'home'>): FileToolPath | null {
  const reads = pathField(READ_PATHS, call.toolName)
  const field = reads ?? pathField(WRITE_PATHS, call.toolName)
  const value = field === undefined ? undefined : call.input[field]
  if (typeof value !== 'string' || value.trim() === '') return null
  return {
    path: absolutePath(value, bounds.root, bounds.home),
    access: reads === undefined ? FolderAccess.ReadWrite : FolderAccess.Read,
  }
}

/**
 * Whether a call asks to run a command outside the sandbox: its input says so, whatever reason the SDK gives, or none
 * (`docs/sdk-notes.md` §15). Anything but a missing `dangerouslyDisableSandbox`, `false` or the string `false` counts:
 * a model may send `"true"`, or something else that Claude Code might take for yes.
 */
export function isSandboxOverride(input: ToolInput): boolean {
  const value = input.dangerouslyDisableSandbox
  if (value === undefined || value === null || value === false) return false
  return !(typeof value === 'string' && value.trim().toLowerCase() === 'false')
}

/** The host a `WebFetch` call's URL names; null when it names none. */
export function fetchedHost(input: ToolInput): string | null {
  const { url } = input
  if (typeof url !== 'string') return null
  const host = URL.parse(url)?.hostname ?? ''
  return host === '' ? null : host
}

/** How a call stands to the sandbox's bounds, and the path it was decided by. */
export interface CallStanding {
  readonly crossing: SandboxCrossing
  /**
   * The key of the path a file tool's call names, resolved once here for whoever goes on to ask which grant covers it;
   * null for any other call, and for a path that can't be resolved.
   */
  readonly key: string | null
}

/** How a call stands to the sandbox's bounds (see the module comment), with the key of the path it names. */
export function callStanding(call: SandboxedCall, bounds: SandboxBounds): CallStanding {
  const { toolName, input } = call
  if (isSandboxOverride(input)) return { crossing: SandboxCrossing.Override, key: null }
  if (toolName === SANDBOX_NETWORK_TOOL) return { crossing: SandboxCrossing.Boundary, key: null }
  if (toolName === 'WebFetch') {
    const host = fetchedHost(input)
    const granted = host !== null && bounds.domains.some((domain) => hostMatches(host, domain))
    return { crossing: granted ? SandboxCrossing.None : SandboxCrossing.Boundary, key: null }
  }
  const read = inputKey(input, pathField(READ_PATHS, toolName), bounds)
  if (read !== undefined) {
    if (read === null) return { crossing: SandboxCrossing.Boundary, key: null }
    if (inAny(read, bounds.credentials)) return { crossing: SandboxCrossing.Credential, key: read }
    if (mayRead(read, bounds)) return { crossing: SandboxCrossing.None, key: read }
    const bounded = inAny(read, bounds.bounded)
    return { crossing: bounded ? SandboxCrossing.Boundary : SandboxCrossing.None, key: read }
  }
  const written = inputKey(input, pathField(WRITE_PATHS, toolName), bounds)
  if (written !== undefined) {
    if (written === null) return { crossing: SandboxCrossing.Boundary, key: null }
    if (inAny(written, bounds.credentials)) return { crossing: SandboxCrossing.Credential, key: written }
    if (!mayWrite(written, bounds)) return { crossing: SandboxCrossing.Boundary, key: written }
    return { crossing: runsCode(written) ? SandboxCrossing.Protected : SandboxCrossing.None, key: written }
  }
  return { crossing: SandboxCrossing.None, key: null }
}

/** How a call stands to the sandbox's bounds (see the module comment). */
export function sandboxCrossing(call: SandboxedCall, bounds: SandboxBounds): SandboxCrossing {
  return callStanding(call, bounds).crossing
}

/** The sandbox a session runs in, as deciding its calls reads it. */
export interface SessionSandbox {
  readonly bounds: SandboxBounds
  /** Whether the sandbox couldn't start in the session: every request to run outside it is then refused. */
  readonly failed: boolean
}

/** What deciding a call reads of its session. */
export interface SessionScope {
  readonly permissionMode: PermissionMode
  /** Glade's own in-process MCP servers (see `permissionVerdict`). */
  readonly gladeServers: readonly string[]
  /** The sandbox the session runs in; null with the sandbox off. */
  readonly sandbox: SessionSandbox | null
  /**
   * The write tools the task was granted whole (Allow for this task), which a sandboxed session isn't told of
   * (`isUnboundedRule`): their writes inside the bounds go ahead in the ask mode.
   */
  readonly writeRules: readonly string[]
}

/** What's decided of a call, and how it stands to the sandbox. */
export interface ToolCallVerdict {
  readonly verdict: PermissionVerdict
  /** `None` with the sandbox off. */
  readonly crossing: SandboxCrossing
}

/**
 * Whether a call Claude Code asks about goes ahead, waits on you, or is refused, in its session's permission mode and
 * sandbox (see the module comment).
 */
export function toolCallVerdict(call: ClassifiedCall & SandboxedCall, session: SessionScope): ToolCallVerdict {
  const { permissionMode, gladeServers, sandbox } = session
  const allowAll = permissionMode === PermissionMode.AllowAll
  if (sandbox !== null) {
    const crossing = sandboxCrossing(call, sandbox.bounds)
    switch (crossing) {
      case SandboxCrossing.Override:
        return { verdict: sandbox.failed ? PermissionVerdict.Refuse : PermissionVerdict.Ask, crossing }
      case SandboxCrossing.Credential:
        return { verdict: PermissionVerdict.Refuse, crossing }
      case SandboxCrossing.Boundary:
      case SandboxCrossing.Protected:
        return { verdict: PermissionVerdict.Ask, crossing }
      case SandboxCrossing.None:
        break
    }
    if (isWriteTool(call.toolName)) {
      // `acceptEdits` lets a write inside the bounds through by itself: this one was held back by Claude Code's check.
      if (allowAll) return { verdict: PermissionVerdict.Ask, crossing: SandboxCrossing.Protected }
      if (!call.matchedAskRule && session.writeRules.includes(call.toolName)) {
        return { verdict: PermissionVerdict.Allow, crossing }
      }
    }
  }
  const verdict = allowAll ? PermissionVerdict.Allow : permissionVerdict(call, gladeServers)
  return { verdict, crossing: SandboxCrossing.None }
}
