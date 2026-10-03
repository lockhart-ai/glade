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
 * The folder a card names is the one a grant would keep (`grantedFolder`): where it really is, links followed. A call
 * whose folder or host can't be granted (the whole disk, a path with a glob character or one that can't be resolved, a
 * host that isn't a name) asks for nothing here: it gets the plain card, which only allows it once.
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
  FolderAccess,
  SandboxAskKind,
  SandboxGrantScope,
  type CardGrantScope,
  type SandboxAsk,
  type SandboxFolderAsk,
} from '../../shared/sandbox'
import { FileAccess, readRuleFolder, SANDBOX_NETWORK_TOOL } from '../agent/sandbox-requests'

import { grantedDomain, grantedFolder } from '../sandbox/grants'
import { absolutePath, canonicalKey, keyInside, pathKey } from './canonical-path'
import {
  fetchedHost,
  fileToolPath,
  inAny,
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

/** The key two spellings of a folder share; a folder that can't be resolved, as written. */
function folderKey(folder: string): string {
  return canonicalKey(folder) ?? pathKey(folder)
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
 * The folder a grant for `path` would name, of `candidates` in order: the first that can be granted and holds the
 * path. Null when none does.
 */
function folderHolding(path: string, candidates: readonly string[]): string | null {
  const key = canonicalKey(path)
  if (key === null) return null
  for (const candidate of candidates) {
    const folder = grantable(candidate, grantedFolder)
    if (folder !== null && keyInside(key, folderKey(folder))) return folder
  }
  return null
}

/** What a file tool's call outside the granted folders asks for: its folder, to read or to write. */
function fileToolAsk(call: AskingCall, bounds: SandboxBounds): SandboxFolderAsk | null {
  const named = fileToolPath(call, bounds)
  if (named === null) return null
  const own = pathKind(named.path) === PathKind.Folder ? named.path : posix.dirname(named.path)
  const folder = folderHolding(named.path, [...suggestedFolders(call.suggestions), own])
  return folder === null ? null : { kind: SandboxAskKind.Folder, path: folder, access: named.access }
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
    const domain = host === null ? null : grantable(host, grantedDomain)
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
}

export type AccessPlan =
  | { readonly kind: AccessPlanKind.Ask; readonly ask: SandboxFolderAsk }
  | { readonly kind: AccessPlanKind.InWorkspace }
  | { readonly kind: AccessPlanKind.AlreadyAllowed; readonly path: string; readonly access: FolderAccess }
  | { readonly kind: AccessPlanKind.Credential }
  | { readonly kind: AccessPlanKind.NotGrantable; readonly problem: string }

/** Whether a path is one `request_access` takes: absolute, or under `~`. */
export function isAccessPath(path: string): boolean {
  return path.startsWith('/') || path === '~' || path.startsWith('~/')
}

/**
 * What becomes of a `request_access` call in a session with these bounds: nothing to decide (the path is in the
 * workspace, already usable as asked, or a credential path, or can't be granted), or a card for its folder.
 */
export function accessPlan(request: Pick<AccessRequest, 'path' | 'access'>, bounds: SandboxBounds): AccessPlan {
  const path = absolutePath(request.path, bounds.root, bounds.home)
  const access = request.access === FileAccess.Read ? FolderAccess.Read : FolderAccess.ReadWrite
  const key = canonicalKey(path, bounds.fs)
  if (key === null) return { kind: AccessPlanKind.NotGrantable, problem: `Can't resolve "${path}"` }
  if (inAny(key, bounds.credentials)) return { kind: AccessPlanKind.Credential }
  // The root is the first of the folders the agent may read.
  if (inAny(key, bounds.readable.slice(0, 1))) return { kind: AccessPlanKind.InWorkspace }
  const usable =
    access === FolderAccess.Read
      ? inAny(key, bounds.readable) || !inAny(key, bounds.bounded)
      : inAny(key, bounds.writable)
  if (usable) return { kind: AccessPlanKind.AlreadyAllowed, path, access }
  const folder = pathKind(path) === PathKind.File ? posix.dirname(path) : path
  try {
    return { kind: AccessPlanKind.Ask, ask: { kind: SandboxAskKind.Folder, path: grantedFolder(folder), access } }
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
}

export type AccessOutcome =
  | {
      readonly kind: AccessOutcomeKind.Allowed
      /** The folder granted, and with what access. */
      readonly folder: string
      readonly access: FolderAccess
      readonly scope: CardGrantScope
    }
  | { readonly kind: AccessOutcomeKind.Denied; readonly note: string | null }
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
      const denied = `Denied: the user didn't allow ${path}, so nothing was granted. Don't retry outside the sandbox.`
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
  }
}
