/**
 * What a call asks of the agent sandbox, as its permission card puts it (#450, #445 "The permission card"): a folder to
 * read or write, a domain to reach, or a command to run outside the sandbox.
 *
 * - **A file tool** outside the granted folders asks for a folder: the one Claude Code's suggestion names
 *   (`Read(//<folder>/**)` for a read, `addDirectories` for a write: the file's own folder), or, with no suggestion
 *   that holds the file, the file's own folder (the path itself, if it's a folder). A read asks for read-only access
 *   and a write for read-write.
 * - **A command's connection** (`SandboxNetworkAccess`) and **`WebFetch`** ask for the host's domain. The connection's
 *   request doesn't name its command (`docs/sdk-notes.md` §15), so whoever asks says which command is running.
 * - **`request_access`** (the Glade tool an agent calls when the sandbox blocked its command) asks for the folder of the
 *   path it names: the path itself if it's a folder, or doesn't exist yet; otherwise the folder the file is in.
 * - **A command asking to run outside the sandbox** asks for just that.
 *
 * The folder a card names is the one a grant would keep (`grantedFolder`): where it really is, links followed, and so
 * is what kind of thing the path is: a link to a file is the file it leads to, in that file's folder. A call whose
 * folder or host can't be granted (the whole disk, a path with a glob character or one that can't be resolved, a host
 * that isn't a plain name) asks for nothing here: a file tool or `WebFetch` gets the plain card, which only allows it
 * once, and a command's connection, which can't be allowed just once, is refused (`../agent/runner`).
 *
 * **A card never offers a folder that's too much** (`isBroadFolder`): the home folder, `/Users`, `/Volumes`,
 * `/System/Volumes`, or anything above one of them. A file whose folder is one of those is asked for by itself: the
 * card names the file, and the grant is that file alone (`SandboxFolderAsk.file`). Such a folder named outright gets
 * the plain card from a file tool, and from `request_access` a refusal that says to add it in Settings.
 *
 * **A card's domain is one host,** never a pattern: `*.github.io` in a URL or a connection is not a name, and a card
 * for it would grant every host under it.
 */
import { statSync } from 'node:fs'
import { posix } from 'node:path'
import {
  PermissionRuleBehavior,
  PermissionUpdateType,
  type PermissionSuggestion,
  type ToolInput,
} from '../../shared/domain'
import {
  coversAccess,
  FolderAccess,
  SandboxAskKind,
  SandboxGrantScope,
  type CardGrantScope,
  type SandboxAsk,
  type SandboxFolderAsk,
  type SandboxGrantAsk,
} from '../../shared/sandbox'
import { FileAccess, isBareHost, readRuleFolder, SANDBOX_NETWORK_TOOL } from '../agent/sandbox-requests'

import { grantedDomain, grantedFolder } from '../sandbox/grants'
import { absolutePath, canonicalPath, keyInside, pathKey } from './canonical-path'
import {
  fetchedHost,
  fileToolPath,
  inAny,
  mayRead,
  mayWrite,
  SandboxCrossing,
  type SandboxBounds,
  type SandboxedCall,
} from './sandbox-classify'

/** A command running in the task, as a connection's card shows it. */
export interface RunningCommand {
  /** Its `Bash` (or `Monitor`) call's `tool_use` id. */
  readonly toolUseId: string
  readonly command: string
  /** What the agent said it's for; null when it didn't. */
  readonly description: string | null
  /** The `Agent` call of the subagent that ran it; null for the task's own agent. */
  readonly parentToolUseId: string | null
}

/** A call that may cross the sandbox's bounds, as working out what it asks for reads it. */
export interface AskingCall extends SandboxedCall {
  readonly suggestions: readonly PermissionSuggestion[]
}

/** What kind of thing a path is on disk. */
enum PathKind {
  Folder = 'folder',
  File = 'file',
  Missing = 'missing',
}

function pathKind(path: string): PathKind {
  try {
    return statSync(path).isDirectory() ? PathKind.Folder : PathKind.File
  } catch {
    return PathKind.Missing
  }
}

/** A folder or domain as grants would keep it, or null when it can't be granted. */
function grantable(value: string, normalize: (value: string) => string): string | null {
  try {
    return normalize(value)
  } catch {
    return null
  }
}

/**
 * Whether the folder with this key is too much for a card to grant: the home folder, a folder the sandbox denies whole
 * (`/Users`, `/Volumes`, `/System/Volumes`), or anything above one of them, the whole disk included. Such a folder is
 * granted in Settings only.
 */
export function isBroadFolder(key: string, bounds: Pick<SandboxBounds, 'bounded'>): boolean {
  return bounds.bounded.some((root) => keyInside(root, key))
}

/** A path and what it is, where it really is: links followed. */
interface RealPath {
  readonly path: string
  readonly kind: PathKind
  /** The folder a grant for it would name: the path itself, unless it's a file, whose folder it is. */
  readonly folder: string
}

/** Where a path really is, and what's there; null when it can't be resolved. */
function realPath(path: string, bounds: Pick<SandboxBounds, 'fs'>): RealPath | null {
  const real = canonicalPath(path, bounds.fs)
  if (real === null) return null
  const kind = pathKind(real)
  return { path: real, kind, folder: kind === PathKind.File ? posix.dirname(real) : real }
}

/** The folders Claude Code suggests opening for a call: a `Read` rule's, or an additional directory. */
function suggestedFolders(suggestions: readonly PermissionSuggestion[]): string[] {
  return suggestions.flatMap((suggestion): string[] => {
    switch (suggestion.type) {
      case PermissionUpdateType.AddRules:
        if (suggestion.behavior !== PermissionRuleBehavior.Allow) return []
        return suggestion.rules.flatMap((rule) =>
          rule.toolName === 'Read' ? (readRuleFolder(rule.ruleContent) ?? []) : [],
        )
      case PermissionUpdateType.AddDirectories:
        return [...suggestion.directories]
      case PermissionUpdateType.ReplaceRules:
      case PermissionUpdateType.RemoveRules:
      case PermissionUpdateType.SetMode:
      case PermissionUpdateType.RemoveDirectories:
        return []
    }
  })
}

/**
 * The folder a grant for the path with key `key` would name, of `candidates` in order: the first that can be granted,
 * holds the path and isn't too much to offer (`isBroadFolder`). Null when none does.
 */
function folderHolding(key: string, candidates: readonly string[], bounds: SandboxBounds): string | null {
  for (const candidate of candidates) {
    const folder = grantable(candidate, grantedFolder)
    if (folder === null) continue
    const folderKey = pathKey(folder)
    if (keyInside(key, folderKey) && !isBroadFolder(folderKey, bounds)) return folder
  }
  return null
}

/**
 * What a file tool's call outside the granted folders asks for: its folder, to read or to write; or the file itself,
 * when its folder is too much to offer. Null for a folder that's too much itself, and for a path no grant can name.
 */
function fileToolAsk(call: AskingCall, bounds: SandboxBounds): SandboxFolderAsk | null {
  const named = fileToolPath(call, bounds)
  const real = named === null ? null : realPath(named.path, bounds)
  if (named === null || real === null) return null
  const { access } = named
  // A path that isn't there yet is a file its tool is about to make.
  const own = real.kind === PathKind.Folder ? real.path : posix.dirname(real.path)
  const folder = folderHolding(pathKey(real.path), [...suggestedFolders(call.suggestions), own], bounds)
  if (folder !== null) return { kind: SandboxAskKind.Folder, path: folder, access }
  if (real.kind === PathKind.Folder || !isBroadFolder(pathKey(own), bounds)) return null
  const file = grantable(real.path, grantedFolder)
  return file === null ? null : { kind: SandboxAskKind.Folder, path: file, access, file: true }
}

/** The host a connection's request names; null when it names none. */
function connectionHost(input: ToolInput): string | null {
  return typeof input.host === 'string' ? input.host : null
}

/**
 * What a call asks of the sandbox, given how it stands to its bounds (`sandboxCrossing`); null for a call that asks
 * nothing of it, and for one whose folder or host can't be granted (see the module comment). `command` is the command
 * running when a connection asked.
 */
export function sandboxAskFor(
  call: AskingCall,
  crossing: SandboxCrossing,
  bounds: SandboxBounds,
  command: RunningCommand | null,
): SandboxAsk | null {
  switch (crossing) {
    case SandboxCrossing.Override:
      return { kind: SandboxAskKind.Outside }
    case SandboxCrossing.Boundary:
      break
    case SandboxCrossing.None:
    case SandboxCrossing.Protected:
    case SandboxCrossing.Credential:
      return null
  }
  const connection = call.toolName === SANDBOX_NETWORK_TOOL
  if (connection || call.toolName === 'WebFetch') {
    const host = connection ? connectionHost(call.input) : fetchedHost(call.input)
    // One host by name, never a pattern: `grantedDomain` alone would take `*.github.io`, which is Settings' to grant.
    const domain = host === null || !isBareHost(host.trim()) ? null : grantable(host, grantedDomain)
    if (domain === null) return null
    return {
      kind: SandboxAskKind.Domain,
      domain,
      command: connection ? (command?.command ?? null) : null,
      commandDescription: connection ? (command?.description ?? null) : null,
    }
  }
  return fileToolAsk(call, bounds)
}

/**
 * Whether a denied request's ask covers a new one, so the denial stands for it too: the same folder (or file), asked
 * for with at least the access that was denied (a denied read denies a write too; a denied write still lets a read
 * ask), or the same domain.
 */
export function deniedCovers(denied: SandboxAsk | null, ask: SandboxGrantAsk): boolean {
  switch (ask.kind) {
    case SandboxAskKind.Folder:
      return (
        denied?.kind === SandboxAskKind.Folder && denied.path === ask.path && coversAccess(ask.access, denied.access)
      )
    case SandboxAskKind.Domain:
      return denied?.kind === SandboxAskKind.Domain && denied.domain === ask.domain
  }
}

/** What `request_access` is called with (`docs/model-surface.md`). */
export interface AccessRequest {
  /** An absolute path, or one under `~`. */
  readonly path: string
  /** Whether the agent needs to read it or to write it: a write asks for read-write access. */
  readonly access: FileAccess
  /** Why the agent needs it, in a line: the card shows it. */
  readonly reason: string
}

/** What becomes of a `request_access` call before anyone is asked. */
export enum AccessPlanKind {
  /** A card asks you for the folder. */
  Ask = 'ask',
  /** The path is in the workspace root, which the agent can always read and write. */
  InWorkspace = 'in_workspace',
  /** The sandbox already lets the agent's commands use the path as asked: it's granted, or it's readable anyway. */
  AlreadyAllowed = 'already_allowed',
  /** The path is a credential file or folder, which no grant opens. */
  Credential = 'credential',
  /** The path isn't one a grant can name. */
  NotGrantable = 'not_grantable',
  /** The path is a folder too much for a card to grant (`isBroadFolder`): it's added in Settings, or not at all. */
  TooBroad = 'too_broad',
}

export type AccessPlan =
  | { readonly kind: AccessPlanKind.Ask; readonly ask: SandboxFolderAsk }
  | { readonly kind: AccessPlanKind.InWorkspace }
  | {
      readonly kind: AccessPlanKind.AlreadyAllowed
      /** The key of the path, where it really is: what a grant that covers it is found by. */
      readonly key: string
      readonly access: FolderAccess
    }
  | { readonly kind: AccessPlanKind.Credential }
  | { readonly kind: AccessPlanKind.NotGrantable; readonly problem: string }
  | { readonly kind: AccessPlanKind.TooBroad }

/** Whether a path is one `request_access` takes: absolute, or under `~`. */
export function isAccessPath(path: string): boolean {
  return path.startsWith('/') || path === '~' || path.startsWith('~/')
}

/**
 * What becomes of a `request_access` call in a session with these bounds: nothing to decide (the path is in the
 * workspace, already usable as asked, a credential path, a folder too much to grant, or can't be granted), or a card:
 * for its folder, or for the file itself when its folder is too much to offer. The path is taken where it really is,
 * links followed, and so is whether it's a file.
 */
export function accessPlan(request: Pick<AccessRequest, 'path' | 'access'>, bounds: SandboxBounds): AccessPlan {
  const path = absolutePath(request.path, bounds.root, bounds.home)
  const access = request.access === FileAccess.Read ? FolderAccess.Read : FolderAccess.ReadWrite
  const real = realPath(path, bounds)
  if (real === null) return { kind: AccessPlanKind.NotGrantable, problem: `Can't resolve "${path}"` }
  const key = pathKey(real.path)
  if (inAny(key, bounds.credentials)) return { kind: AccessPlanKind.Credential }
  // The root is the first of the folders the agent may read.
  if (inAny(key, bounds.readable.slice(0, 1))) return { kind: AccessPlanKind.InWorkspace }
  const usable =
    access === FolderAccess.Read ? mayRead(key, bounds) || !inAny(key, bounds.bounded) : mayWrite(key, bounds)
  if (usable) return { kind: AccessPlanKind.AlreadyAllowed, key, access }
  // A folder that's too much to offer: its file is asked for by itself, and the folder not at all.
  const broad = isBroadFolder(pathKey(real.folder), bounds)
  if (broad && real.kind !== PathKind.File) return { kind: AccessPlanKind.TooBroad }
  try {
    const granted = grantedFolder(broad ? real.path : real.folder)
    const ask: SandboxFolderAsk = { kind: SandboxAskKind.Folder, path: granted, access }
    return { kind: AccessPlanKind.Ask, ask: broad ? { ...ask, file: true } : ask }
  } catch (error) {
    return { kind: AccessPlanKind.NotGrantable, problem: error instanceof Error ? error.message : String(error) }
  }
}

/** How a `request_access` call ended. */
export enum AccessOutcomeKind {
  /** You allowed it: the folder is granted, and the grant is live in the session. */
  Allowed = 'allowed',
  Denied = 'denied',
  /** The request closed without an answer: Stop, the turn ending, or the session closing. */
  Withdrawn = 'withdrawn',
  /** The session isn't sandboxed: nothing to grant. */
  SandboxOff = 'sandbox_off',
  InWorkspace = 'in_workspace',
  AlreadyAllowed = 'already_allowed',
  Credential = 'credential',
  NotGrantable = 'not_grantable',
  TooBroad = 'too_broad',
}

export type AccessOutcome =
  | {
      readonly kind: AccessOutcomeKind.Allowed
      /** The folder granted (or the single file), and with what access. */
      readonly folder: string
      readonly access: FolderAccess
      readonly scope: CardGrantScope
    }
  | {
      readonly kind: AccessOutcomeKind.Denied
      readonly note: string | null
      /** Whether no card was shown: you denied the same thing earlier in the turn, and that answer stands. */
      readonly earlier?: true
    }
  | { readonly kind: AccessOutcomeKind.Withdrawn }
  | { readonly kind: AccessOutcomeKind.SandboxOff }
  | { readonly kind: AccessOutcomeKind.InWorkspace }
  | {
      readonly kind: AccessOutcomeKind.AlreadyAllowed
      /** Whose grant covers it; null when no grant is needed (a read outside the folders the sandbox denies). */
      readonly scope: SandboxGrantScope | null
    }
  | { readonly kind: AccessOutcomeKind.Credential }
  | { readonly kind: AccessOutcomeKind.NotGrantable; readonly problem: string }
  | { readonly kind: AccessOutcomeKind.TooBroad }

/** What `request_access` answers the agent: the text, and whether it's a tool error. */
export interface AccessReply {
  readonly text: string
  readonly isError: boolean
}

/** What a folder's access lets the agent do, in the tool's words. */
function accessWords(access: FolderAccess): string {
  return access === FolderAccess.Read ? 'read' : 'read and write'
}

/** Whose grant it is, in the tool's words. */
function scopeWords(scope: SandboxGrantScope): string {
  switch (scope) {
    case SandboxGrantScope.Task:
      return 'this task'
    case SandboxGrantScope.Workspace:
      return 'this workspace'
    case SandboxGrantScope.Glade:
      return 'every workspace'
  }
}

/** What the agent is told when its `request_access` was withdrawn. */
export const ACCESS_WITHDRAWN = 'No decision was made: the request was withdrawn before the user answered.'

/** What the agent is told when it asks for a path that isn't absolute. */
export const ACCESS_PATH_NOT_ABSOLUTE = 'Give the absolute path the command was blocked from, e.g. /Users/me/.cache/uv.'

/** What `request_access` tells the agent of how its call ended: each a message it can act on. */
export function accessReply(outcome: AccessOutcome, request: Pick<AccessRequest, 'path'>): AccessReply {
  const { path } = request
  switch (outcome.kind) {
    case AccessOutcomeKind.Allowed:
      return {
        text:
          `Allowed for ${scopeWords(outcome.scope)}: you can now ${accessWords(outcome.access)} ${outcome.folder}. ` +
          'Run the command that was blocked again.',
        isError: false,
      }
    case AccessOutcomeKind.Denied: {
      const denied =
        outcome.earlier === true
          ? `Denied: the user already denied ${path} earlier in this turn, so they weren't asked again and nothing ` +
            "was granted. Don't ask for it again, and don't retry outside the sandbox."
          : `Denied: the user didn't allow ${path}, so nothing was granted. Don't retry outside the sandbox.`
      return { text: outcome.note === null ? denied : `${denied} The user said: ${outcome.note}`, isError: true }
    }
    case AccessOutcomeKind.Withdrawn:
      return { text: ACCESS_WITHDRAWN, isError: true }
    case AccessOutcomeKind.SandboxOff:
      return {
        text: "The sandbox is off in this session, so it didn't block anything and there's nothing to grant.",
        isError: false,
      }
    case AccessOutcomeKind.InWorkspace:
      return {
        text:
          `${path} is inside the workspace, which you can already read and write, so there's nothing to grant. A ` +
          'write the sandbox still blocks there is to a file it always protects (.git/config, .git/hooks, .claude).',
        isError: false,
      }
    case AccessOutcomeKind.AlreadyAllowed:
      return {
        text:
          outcome.scope === null
            ? `You can already use ${path} that way: nothing needs granting.`
            : `${path} is already granted for ${scopeWords(outcome.scope)} with that access: nothing more to grant.`,
        isError: false,
      }
    case AccessOutcomeKind.Credential:
      return {
        text:
          `Refused: ${path} is one of the credential files and folders the sandbox never opens, even inside a ` +
          "granted folder. Don't try to reach it another way.",
        isError: true,
      }
    case AccessOutcomeKind.NotGrantable:
      return { text: `${outcome.problem}. Ask for a folder, by its absolute path.`, isError: true }
    case AccessOutcomeKind.TooBroad:
      return {
        text:
          `Refused: ${path} is too much to grant from a request (the home folder, or a folder that holds it, other ` +
          "users' folders or other volumes). Ask for the folder inside it that the command needs. If the task really " +
          'needs all of it, tell the user: they can add it under Sandbox in Settings.',
        isError: true,
      }
  }
}
