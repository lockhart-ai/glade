/**
 * What a subagent's opened tile shows of it in the todo hub (#499): the subagent as the Subagents tab has it
 * (`Subagent`, with its log), found in the store by the `tool_use` id of its `Agent` call.
 *
 * Every opened tile's selector runs on every change to the store, so nothing here walks the tool log per tile: a
 * task's subagents are worked out once per log (and per workspace root and permission lines), the first time an opened
 * tile asks, and kept for as long as that log is the store's. A task's opened tiles share the one answer.
 */
import { useRef } from 'react'
import type { PermissionMark, PermissionRequest, ToolEvent } from '../../../shared/domain'
import type { PermissionLines } from '../../permissions/permissionLineModel'
import { permissionLinesByToolUse } from '../../permissions/permissionLines'
import type { GladeState } from '../../store/state'
import { sameSubagent, subagentsByToolUse, type Subagent } from '../../subagents/subagentsModel'

const NO_REQUESTS: readonly PermissionRequest[] = []
const NO_MARKS: readonly PermissionMark[] = []

/** A task's permission lines, as they were last worked out from its requests and marks. */
interface KnownLines {
  readonly marks: readonly PermissionMark[]
  readonly lines: PermissionLines
}

const knownLines = new WeakMap<readonly PermissionRequest[], KnownLines>()

/**
 * Each call's permission line by its `tool_use` id (`permissionLinesByToolUse`), worked out once for a task's requests
 * and marks: the same lines, not ones made anew, for every tile that asks while neither list has changed.
 */
export function permissionLinesOf(
  requests: readonly PermissionRequest[] = NO_REQUESTS,
  marks: readonly PermissionMark[] = NO_MARKS,
): PermissionLines {
  let known = knownLines.get(requests)
  if (known?.marks !== marks) {
    known = { marks, lines: permissionLinesByToolUse(requests, marks) }
    knownLines.set(requests, known)
  }
  return known.lines
}

/** A tool log's subagents, as they were last worked out. */
interface KnownSubagents {
  readonly rootPath: string | undefined
  readonly permissions: PermissionLines
  readonly byToolUse: ReadonlyMap<string, Subagent>
}

const knownSubagents = new WeakMap<readonly ToolEvent[], KnownSubagents>()

/**
 * The subagent an `Agent` call started, with its log, among a task's tool log; undefined for one the log hasn't got.
 * `rootPath` makes file arguments relative to the workspace root, and `permissions` gives each call its permission line.
 */
export function subagentIn(
  events: readonly ToolEvent[] | undefined,
  toolUseId: string,
  rootPath: string | undefined,
  permissions: PermissionLines,
): Subagent | undefined {
  if (events === undefined) return undefined
  let known = knownSubagents.get(events)
  if (known === undefined || known.rootPath !== rootPath || known.permissions !== permissions) {
    known = { rootPath, permissions, byToolUse: subagentsByToolUse(events, rootPath, permissions) }
    knownSubagents.set(events, known)
  }
  return known.byToolUse.get(toolUseId)
}

/** The root of the workspace a task is in, which its file arguments show relative to; undefined for a task not loaded. */
export function rootPathOfTask(state: Pick<GladeState, 'tasks' | 'workspaces'>, taskId: string): string | undefined {
  const workspaceId = state.tasks[taskId]?.workspaceId
  return state.workspaces.find(({ id }) => id === workspaceId)?.rootPath
}

/** A task's subagent as the store has it now, with its log (`subagentIn`). */
export function selectSubagent(state: GladeState, taskId: string, toolUseId: string): Subagent | undefined {
  return subagentIn(
    state.toolEvents[taskId],
    toolUseId,
    rootPathOfTask(state, taskId),
    permissionLinesOf(state.permissionRequests[taskId], state.permissionMarks[taskId]),
  )
}

/** Whether a tile's subagent shows the same: the same one, or one made anew from the same call and log. */
export function sameShownSubagent(a: Subagent | undefined, b: Subagent | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && sameSubagent(a, b))
}

/**
 * A selector that answers with the value it last gave while `same` says the new one shows the same, as zustand's
 * `useShallow` does for shallow equality: a component that selects with it renders again only when what it shows
 * changed, though the store makes the value anew with every change.
 */
export function useSameSelector<S, T>(selector: (state: S) => T, same: (a: T, b: T) => boolean): (state: S) => T {
  const last = useRef<{ readonly value: T } | null>(null)
  return (state) => {
    const next = selector(state)
    if (last.current !== null && same(last.current.value, next)) return last.current.value
    last.current = { value: next }
    return next
  }
}
