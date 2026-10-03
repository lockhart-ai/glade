/**
 * What Claude Code's sandbox asks the host and tells the agent, in the shapes the P15-01 probes recorded
 * (`docs/sdk-notes.md` §15), for the test backends to play: the scripted session (`./scripted-session`) and the fake
 * one (`./fake-backend`). Nothing here runs a sandbox.
 *
 * - A sandboxed command reaching a host it may not asks `canUseTool("SandboxNetworkAccess", { host })`, under a fresh
 *   id of its own rather than its `Bash` call's.
 * - `WebFetch` to a domain it may not asks as itself. Both suggest the same rule, `WebFetch(domain:<host>)`.
 * - A file tool reading or writing outside the folders it may use asks with the reason `OUTSIDE_WORKING_DIRECTORIES`
 *   and a suggestion naming the file's folder, and no `blockedPath`.
 * - A command asking to run outside the sandbox (`dangerouslyDisableSandbox: true`) asks with the reason
 *   `SANDBOX_OVERRIDE_REASON`, and no suggestions.
 * - A command the sandbox blocked fails as it would anywhere; only a denied connection adds a `<sandbox_violations>`
 *   block. Seatbelt logs the file denials, each naming its call (`seatbeltLog`).
 * - A sandbox that can't start fails every command with `sandboxInitFailure`.
 */
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import {
  PermissionDestination,
  PermissionRuleBehavior,
  PermissionUpdateType,
  type PermissionRule,
  type PermissionSuggestion,
  type ToolInput,
} from '../../shared/domain'
import type { ToolPermissionCall } from './backend'

/** The tool a sandboxed command's connection asks about: not one the model calls. */
export const SANDBOX_NETWORK_TOOL = 'SandboxNetworkAccess'

/** Why a file tool asks about a path outside the folders it may use. */
export const OUTSIDE_WORKING_DIRECTORIES = 'Path is outside allowed working directories'

/** Why a command asking to run outside the sandbox asks. */
export const SANDBOX_OVERRIDE_REASON = 'dangerouslyDisableSandbox'

/** The ask rule that makes running outside the sandbox always ask, whatever allows the command itself. */
export const SANDBOX_OVERRIDE_ASK_RULE = 'Bash(dangerouslyDisableSandbox:true)'

/** The port a connection goes to unless a step says otherwise: HTTPS's. */
export const HTTPS_PORT = 443

/** What Seatbelt denied, as its log names the operation (`docs/sdk-notes.md` §15). */
export enum SandboxOperation {
  ReadData = 'file-read-data',
  ReadMetadata = 'file-read-metadata',
  WriteCreate = 'file-write-create',
  WriteData = 'file-write-data',
  WriteUnlink = 'file-write-unlink',
}

/** Whether a file tool reads a path or writes it. */
export enum FileAccess {
  Read = 'read',
  Write = 'write',
}

/** The file tools Claude Code holds to the folders it may use, by the input field naming the file. */
export const FILE_TOOL_PATHS: Readonly<Record<string, string>> = {
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
}

/** A tool call the sandbox asks about, as `ToolPermissionCall` has it but for the signal the asker adds. */
export type SandboxCall = Omit<ToolPermissionCall, 'signal'>

/** A call with nothing set but its tool, input and id: a top-level call that suggests nothing. */
function call(toolName: string, input: ToolInput, toolUseId: string): SandboxCall {
  return {
    toolName,
    input,
    toolUseId,
    agentId: null,
    title: null,
    displayName: toolName,
    description: null,
    suggestions: [],
    defaultToNo: false,
    suppressAlwaysAllowRule: false,
    mcpServer: null,
    matchedAskRule: false,
    blockedPath: null,
    decisionReason: null,
  }
}

/** The rule that lets `WebFetch`, and the sandbox's commands, reach a host. */
export function domainRule(host: string): PermissionRule {
  return { toolName: 'WebFetch', ruleContent: `domain:${host}` }
}

/** `domainRule` as a rule string, as settings take it: `WebFetch(domain:<host>)`. */
export function domainRuleString(host: string): string {
  return `WebFetch(domain:${host})`
}

/** What Claude Code suggests for a host: its domain rule, to the project's local settings (Glade rewrites that). */
export function domainSuggestions(host: string): readonly PermissionSuggestion[] {
  return [
    {
      type: PermissionUpdateType.AddRules,
      rules: [domainRule(host)],
      behavior: PermissionRuleBehavior.Allow,
      destination: PermissionDestination.LocalSettings,
    },
  ]
}

/** The rule content of a `Read` rule for a folder and everything in it: `//<absolute folder>/**`. */
export function readRuleContent(folder: string): string {
  return `/${folder}/**`
}

/**
 * What Claude Code suggests for a file outside the folders a file tool may use: a `Read` rule for its folder, or the
 * folder as an additional directory for a write, for the session.
 */
export function folderSuggestions(folder: string, access: FileAccess): readonly PermissionSuggestion[] {
  switch (access) {
    case FileAccess.Read:
      return [
        {
          type: PermissionUpdateType.AddRules,
          rules: [{ toolName: 'Read', ruleContent: readRuleContent(folder) }],
          behavior: PermissionRuleBehavior.Allow,
          destination: PermissionDestination.Session,
        },
      ]
    case FileAccess.Write:
      return [
        {
          type: PermissionUpdateType.AddDirectories,
          directories: [folder],
          destination: PermissionDestination.Session,
        },
      ]
  }
}

/** A path as Claude Code describes it: the home folder as `~`. */
export function homeAbbreviated(path: string, home: string = homedir()): string {
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** A sandboxed command's connection to a host it may not reach, asked about while the connection waits. */
export function networkAccessCall(host: string, requestId: string): SandboxCall {
  return {
    ...call(SANDBOX_NETWORK_TOOL, { host }, requestId),
    description: `Allow network connection to ${host}?`,
    suggestions: domainSuggestions(host),
  }
}

/** A `WebFetch` call to a domain it may not reach. */
export function webFetchCall(toolUseId: string, input: ToolInput & { readonly url: string }): SandboxCall {
  return {
    ...call('WebFetch', input, toolUseId),
    description: input.url,
    suggestions: domainSuggestions(new URL(input.url).hostname),
  }
}

/** A file tool's call on `path`, outside the folders it may use. */
export function outsideFileCall(
  toolUseId: string,
  toolName: string,
  input: ToolInput,
  path: string,
  access: FileAccess,
  home: string = homedir(),
): SandboxCall {
  return {
    ...call(toolName, input, toolUseId),
    description: homeAbbreviated(path, home),
    decisionReason: OUTSIDE_WORKING_DIRECTORIES,
    suggestions: folderSuggestions(dirname(path), access),
  }
}

/**
 * A command asking to run outside the sandbox. With Glade's ask rule (`SANDBOX_OVERRIDE_ASK_RULE`), Claude Code says
 * that rule forced the ask.
 */
export function sandboxOverrideCall(toolUseId: string, input: ToolInput, askRule: boolean): SandboxCall {
  return { ...call('Bash', input, toolUseId), decisionReason: SANDBOX_OVERRIDE_REASON, matchedAskRule: askRule }
}

/** A failed command's result, as Claude Code gives it: its exit code, then what it printed. */
export function commandFailure(output: string, exitCode = 1): string {
  return `Exit code ${String(exitCode)}\n${output}`
}

/** Claude Code's block naming what the sandbox denied, one line each. */
export function sandboxViolations(lines: readonly string[]): string {
  return ['<sandbox_violations>', ...lines, '</sandbox_violations>'].join('\n')
}

/** The line naming a connection the user didn't allow. */
export function networkDenial(host: string, port: number = HTTPS_PORT): string {
  return `deny network-outbound ${host}:${String(port)} (user denied)`
}

/** What every command fails with when the sandbox couldn't start and must (`failIfUnavailable`). */
export function sandboxInitFailure(reason: string): string {
  return `Sandbox is required but failed to initialize: ${reason}. Restart to retry.`
}

/** One file denial by Seatbelt during a command. */
export interface SandboxDenial {
  /** The process denied, as Seatbelt names it, e.g. `cat`. */
  readonly process: string
  readonly operation: SandboxOperation
  readonly path: string
}

/** The suffix Claude Code tags a scripted session's commands' denials with: random per process in the real one. */
export const SCRIPTED_SANDBOX_TAG = '_scripted_SBX'

/**
 * A denial as `log stream --predicate '(eventMessage ENDSWITH "_SBX")' --style compact` prints it: the kernel's line,
 * then the tag naming the call, its `tool_use` id in base64 (`docs/sdk-notes.md` §15).
 */
export function seatbeltLog(toolUseId: string, denial: SandboxDenial, at: Date = new Date(), pid = 4242): string {
  const time = at.toISOString().replace('T', ' ').slice(0, 23)
  const tag = Buffer.from(toolUseId.slice(0, 100)).toString('base64')
  return [
    `${time} E  kernel[0:1a2b3c] (Sandbox) Sandbox: ${denial.process}(${String(pid)}) deny(1) ${denial.operation} ${denial.path}`,
    `CMD64_${tag}_END_${SCRIPTED_SANDBOX_TAG}`,
  ].join('\n')
}

/** Whether `host` is a bare host name, as the network request names one: no scheme, port, path or spaces. */
export function isBareHost(host: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(host)
}

/** Whether a host matches a domain as the sandbox's lists name it: exactly, or under a `*.` wildcard. */
export function hostMatches(host: string, domain: string): boolean {
  if (domain.startsWith('*.')) return host.endsWith(domain.slice(1))
  return host === domain
}

/** Whether `path` is `folder` or inside it. */
export function isInside(path: string, folder: string): boolean {
  const base = folder.endsWith('/') ? folder.slice(0, -1) : folder
  return path === base || path.startsWith(`${base}/`)
}
