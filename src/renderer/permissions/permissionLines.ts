/**
 * Where a tool call's row gets its permission line (`./permissionLineModel`): from the task's permission requests, and
 * from the marks of the calls a rule decided. A request names the call it was about by its `tool_use` id
 * (`PermissionRequest.toolUseId`), which the call's row has too (`ToolCallEvent.toolUseId`), so the rows look their
 * lines up by it (`permissionLinesByToolUse`). A subagent's call is found the same way, on the row it already has in
 * the Subagents tab. A command's connection asks under its command's id, so its decision is on the command's row.
 *
 * A card shows in the chat only while its request is open (#459): from then on, this line is where its decision shows.
 * A request of the agent sandbox's (#450) says what it was about: "Allowed for this workspace: write to
 * ~/code/acme-web/src/api", "Denied: reach registry.npmjs.org · “No installs.”". A call nobody was asked about, because
 * a rule decided it (`PermissionMark`), says which: "Allowed by workspace grant: read ~/code/acme-shared", "Allowed by
 * task rule: npm run lint commands", "Blocked by the sandbox: write to ~/.cache/uv". Your own answer on a call comes
 * before a rule's.
 */
import {
  PermissionMarkKind,
  PermissionRequestState,
  type PermissionMark,
  type PermissionRequest,
  type PermissionRule,
} from '../../shared/domain'
import { sandboxAskPhrase, SandboxGrantScope } from '../../shared/sandbox'
import { ruleGrant, TaskGrantKind } from './permissionCardModel'
import {
  NO_PERMISSION_LINES,
  PermissionLineScope,
  PermissionLineState,
  type PermissionLine,
  type PermissionLines,
} from './permissionLineModel'

/**
 * What a rule granted with Allow for this task covers, as its line names it: "npm test commands" for a command prefix,
 * the command for one command exactly, and the tool's name for a whole tool ("Edit"), as the card's button named them.
 */
export function grantedRuleSubject(rule: PermissionRule): string {
  const grant = ruleGrant(rule)
  switch (grant.kind) {
    case TaskGrantKind.Prefix:
      return `${grant.subject} commands`
    case TaskGrantKind.Tool:
    case TaskGrantKind.Command:
      return grant.subject
  }
}

/** What a request's line needs of it. */
type LinedRequest = Pick<PermissionRequest, 'state' | 'denyNote' | 'grantedRule'> &
  Partial<Pick<PermissionRequest, 'sandbox' | 'grantedScope'>>

/** How far an allowed request reaches: a folder or domain by who it was granted to, any other by its rule, or once. */
function allowedScope(request: LinedRequest): PermissionLineScope {
  if (request.grantedScope === SandboxGrantScope.Workspace) return PermissionLineScope.Workspace
  return request.grantedScope === SandboxGrantScope.Task || request.grantedRule !== null
    ? PermissionLineScope.Task
    : PermissionLineScope.Once
}

/**
 * A permission request's line: "Waiting on you" while its card is open, then "Allowed once", "Allowed for this task:
 * npm test commands" (naming the rule it granted), "Denied" or "Denied: “your note”", or "Withdrawn". An Ask before
 * edits request's call is already on the row, so there's nothing more to name; a request of the sandbox's names what it
 * was about ("read ~/code/acme-web", "reach registry.npmjs.org", "run outside the sandbox"), in every state.
 */
export function requestPermissionLine(request: LinedRequest): PermissionLine {
  const asked = request.sandbox == null ? null : sandboxAskPhrase(request.sandbox)
  switch (request.state) {
    case PermissionRequestState.Open:
      return { state: PermissionLineState.Waiting, subject: asked }
    case PermissionRequestState.Allowed:
      return {
        state: PermissionLineState.Allowed,
        scope: allowedScope(request),
        subject: asked ?? (request.grantedRule === null ? null : grantedRuleSubject(request.grantedRule)),
      }
    case PermissionRequestState.Denied:
      return { state: PermissionLineState.Denied, subject: asked, note: request.denyNote }
    case PermissionRequestState.Withdrawn:
      return { state: PermissionLineState.Withdrawn, subject: asked }
  }
}

/** Whose grant let a call through, as its line says. */
function grantScope(scope: SandboxGrantScope): PermissionLineScope {
  switch (scope) {
    case SandboxGrantScope.Task:
      return PermissionLineScope.TaskGrant
    case SandboxGrantScope.Workspace:
      return PermissionLineScope.WorkspaceGrant
    case SandboxGrantScope.Glade:
      return PermissionLineScope.GladeGrant
  }
}

/**
 * The line of a call a rule decided: "Allowed by workspace grant: read ~/code/acme-shared", "Allowed by task rule: npm
 * run lint commands", or "Blocked by the sandbox", with what of once that's known ("write to ~/.cache/uv").
 */
export function markPermissionLine({ outcome }: Pick<PermissionMark, 'outcome'>): PermissionLine {
  switch (outcome.kind) {
    case PermissionMarkKind.Grant:
      return {
        state: PermissionLineState.Allowed,
        scope: grantScope(outcome.scope),
        subject: sandboxAskPhrase(outcome.ask),
      }
    case PermissionMarkKind.TaskRule:
      return {
        state: PermissionLineState.Allowed,
        scope: PermissionLineScope.TaskRule,
        subject: grantedRuleSubject(outcome.rule),
      }
    case PermissionMarkKind.Blocked:
      return {
        state: PermissionLineState.Blocked,
        subject: outcome.ask === null ? null : sandboxAskPhrase(outcome.ask),
      }
  }
}

/** No marks: a task where no rule decided a call. */
const NO_MARKS: readonly PermissionMark[] = []

/**
 * Each tool call's permission line, by the call's `tool_use` id, from a task's permission requests (in the order they
 * were made) and the marks of the calls a rule decided. A call with several requests shows the one still waiting on
 * you, the first of them, and otherwise its latest; a call you were asked about shows that, whatever a rule decided of
 * it too.
 */
export function permissionLinesByToolUse(
  requests: readonly PermissionRequest[],
  marks: readonly PermissionMark[] = NO_MARKS,
): PermissionLines {
  if (requests.length === 0 && marks.length === 0) return NO_PERMISSION_LINES
  const lines = new Map<string, PermissionLine>()
  for (const mark of marks) lines.set(mark.toolUseId, markPermissionLine(mark))
  const waiting = new Set<string>()
  for (const request of requests) {
    if (waiting.has(request.toolUseId)) continue
    lines.set(request.toolUseId, requestPermissionLine(request))
    if (request.state === PermissionRequestState.Open) waiting.add(request.toolUseId)
  }
  return lines
}
