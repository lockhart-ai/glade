/**
 * Where a tool call's row gets its permission line (`./permissionLineModel`): from the task's permission requests. A
 * request names the call it was about by its `tool_use` id (`PermissionRequest.toolUseId`), which the call's row has too
 * (`ToolCallEvent.toolUseId`), so the rows look their lines up by it (`permissionLinesByToolUse`). A subagent's call is
 * found the same way, on the row it already has in the Subagents tab.
 *
 * A card shows in the chat only while its request is open (#459): from then on, this line is where its decision shows.
 */
import { PermissionRequestState, type PermissionRequest, type PermissionRule } from '../../shared/domain'
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

/**
 * A permission request's line: "Waiting on you" while its card is open, then "Allowed once", "Allowed for this task:
 * npm test commands" (naming the rule it granted), "Denied" or "Denied: “your note”", or "Withdrawn". The request's call
 * is already on the row, so there's nothing more to name.
 */
export function requestPermissionLine(
  request: Pick<PermissionRequest, 'state' | 'denyNote' | 'grantedRule'>,
): PermissionLine {
  switch (request.state) {
    case PermissionRequestState.Open:
      return { state: PermissionLineState.Waiting, subject: null }
    case PermissionRequestState.Allowed:
      return request.grantedRule === null
        ? { state: PermissionLineState.Allowed, scope: PermissionLineScope.Once, subject: null }
        : {
            state: PermissionLineState.Allowed,
            scope: PermissionLineScope.Task,
            subject: grantedRuleSubject(request.grantedRule),
          }
    case PermissionRequestState.Denied:
      return { state: PermissionLineState.Denied, subject: null, note: request.denyNote }
    case PermissionRequestState.Withdrawn:
      return { state: PermissionLineState.Withdrawn, subject: null }
  }
}

/**
 * Each tool call's permission line, by the call's `tool_use` id, from a task's permission requests (in the order they
 * were made). A call with several requests shows the one still waiting on you, the first of them, and otherwise its
 * latest.
 */
export function permissionLinesByToolUse(requests: readonly PermissionRequest[]): PermissionLines {
  if (requests.length === 0) return NO_PERMISSION_LINES
  const lines = new Map<string, PermissionLine>()
  const waiting = new Set<string>()
  for (const request of requests) {
    if (waiting.has(request.toolUseId)) continue
    lines.set(request.toolUseId, requestPermissionLine(request))
    if (request.state === PermissionRequestState.Open) waiting.add(request.toolUseId)
  }
  return lines
}
