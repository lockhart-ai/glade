/**
 * The permission line on a tool call's row (`docs/design/README.md`, "The shield marks anything about the sandbox or a
 * permission"; screens 23, 24 and 42–44): what was decided about the call, and by whom. Every line has one shape, status
 * first: the shield, the status ("Allowed for this task"), a colon, then what it was about ("read ~/code/acme-web") and,
 * on a denial, your note. The shield's colour is the state: teal granted, pink denied or blocked, purple waiting on you,
 * slate withdrawn. Who decided is in the wording: "Allowed for this task" is your answer on a card, "Allowed by workspace
 * grant" a rule's.
 *
 * This file is the line alone: its data (`PermissionLine`) and its words. Where a row's line comes from is
 * `./permissionLines`.
 */

/** What became of a permission, which the shield's colour shows. */
export enum PermissionLineState {
  /** Its card is open: purple. */
  Waiting = 'waiting',
  /** Granted, by you on a card or by a rule (`PermissionLineScope`): teal. */
  Allowed = 'allowed',
  /** You denied it on a card: pink. */
  Denied = 'denied',
  /** The sandbox refused it: pink. */
  Blocked = 'blocked',
  /** The request went away without an answer: slate, the whole line dimmed. */
  Withdrawn = 'withdrawn',
}

/** How far a granted permission reaches, and so who granted it: you on a card, or a rule. */
export enum PermissionLineScope {
  /** You, for this call alone: "Allowed once". */
  Once = 'once',
  /** You, for the rest of the task: "Allowed for this task". */
  Task = 'task',
  /** You, for every task in the workspace: "Allowed for this workspace". */
  Workspace = 'workspace',
  /** A rule an earlier Allow for this task made: "Allowed by task rule". */
  TaskRule = 'task_rule',
  /** A workspace's grant, from a card or Settings › Workspace: "Allowed by workspace grant". */
  WorkspaceGrant = 'workspace_grant',
  /** A Glade-wide grant, from Settings › Agent: "Allowed by Glade-wide grant". */
  GladeGrant = 'glade_grant',
}

interface PermissionLineBase {
  /**
   * What it was about, after the colon: "read ~/code/acme-web", "reach registry.npmjs.org", "npm test commands". Null
   * when there's nothing to name, e.g. an Ask before edits card, whose call is already on the row.
   */
  readonly subject: string | null
}

export interface WaitingPermissionLine extends PermissionLineBase {
  readonly state: PermissionLineState.Waiting
}

export interface AllowedPermissionLine extends PermissionLineBase {
  readonly state: PermissionLineState.Allowed
  readonly scope: PermissionLineScope
}

export interface DeniedPermissionLine extends PermissionLineBase {
  readonly state: PermissionLineState.Denied
  /** The note you denied it with, shown last, in quotes; null when you gave none. */
  readonly note: string | null
}

export interface BlockedPermissionLine extends PermissionLineBase {
  readonly state: PermissionLineState.Blocked
}

export interface WithdrawnPermissionLine extends PermissionLineBase {
  readonly state: PermissionLineState.Withdrawn
}

/** A row's permission line. */
export type PermissionLine =
  WaitingPermissionLine | AllowedPermissionLine | DeniedPermissionLine | BlockedPermissionLine | WithdrawnPermissionLine

/** Each tool call's permission line, by the call's `tool_use` id: how a row finds its own. */
export type PermissionLines = ReadonlyMap<string, PermissionLine>

/** No lines: a task with no permission requests. */
export const NO_PERMISSION_LINES: PermissionLines = new Map()

function allowedStatus(scope: PermissionLineScope): string {
  switch (scope) {
    case PermissionLineScope.Once:
      return 'Allowed once'
    case PermissionLineScope.Task:
      return 'Allowed for this task'
    case PermissionLineScope.Workspace:
      return 'Allowed for this workspace'
    case PermissionLineScope.TaskRule:
      return 'Allowed by task rule'
    case PermissionLineScope.WorkspaceGrant:
      return 'Allowed by workspace grant'
    case PermissionLineScope.GladeGrant:
      return 'Allowed by Glade-wide grant'
  }
}

/** The line's status, which it starts with: "Allowed once", "Denied", "Blocked by the sandbox", "Waiting on you". */
export function permissionStatus(line: PermissionLine): string {
  switch (line.state) {
    case PermissionLineState.Waiting:
      return 'Waiting on you'
    case PermissionLineState.Allowed:
      return allowedStatus(line.scope)
    case PermissionLineState.Denied:
      return 'Denied'
    case PermissionLineState.Blocked:
      return 'Blocked by the sandbox'
    case PermissionLineState.Withdrawn:
      return 'Withdrawn'
  }
}

/** A text trimmed, or null when there's nothing to it. */
function nonBlank(text: string | null): string | null {
  const trimmed = text?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

/**
 * What follows the status and its colon: what it was about, then a denial's note in quotes after a middle dot ("reach
 * registry.npmjs.org · “No installs.”"), or whichever of the two there is. Null for a line that's its status alone.
 */
export function permissionDetail(line: PermissionLine): string | null {
  const subject = nonBlank(line.subject)
  const note = line.state === PermissionLineState.Denied ? nonBlank(line.note) : null
  const quoted = note === null ? null : `“${note}”`
  if (subject === null) return quoted
  return quoted === null ? subject : `${subject} · ${quoted}`
}

/** The whole line as text: "Allowed once", "Denied: “Keep dist.”", "Allowed for this task: npm test commands". */
export function permissionLineText(line: PermissionLine): string {
  const detail = permissionDetail(line)
  return detail === null ? permissionStatus(line) : `${permissionStatus(line)}: ${detail}`
}

/** Whether two lines show the same. A row's line is made anew whenever the requests change, so it's told by value. */
export function samePermissionLine(a: PermissionLine | null, b: PermissionLine | null): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  return a.state === b.state && permissionLineText(a) === permissionLineText(b)
}

/**
 * Whether the call under a line ran, so its row still shows its result: a granted call did, and so did one the sandbox
 * blocked something of (its own "Operation not permitted" says so). A call still waiting hasn't, and a denied or
 * withdrawn one never did: the line says all there is to say.
 */
export function ranWithPermission(line: PermissionLine): boolean {
  switch (line.state) {
    case PermissionLineState.Allowed:
    case PermissionLineState.Blocked:
      return true
    case PermissionLineState.Waiting:
    case PermissionLineState.Denied:
    case PermissionLineState.Withdrawn:
      return false
  }
}
