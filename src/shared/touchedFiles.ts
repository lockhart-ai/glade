/**
 * What the Files tab shows, worked out from a task's tool log: the files the agent changed and the ones it only read,
 * relative to the workspace root, and what the viewer needs to know about each. Shared so main can work the summary
 * out over a task's whole history and send it with its first load (#637), however little of the log it sends.
 */
import { ToolCallState, ToolEventKind, type EpochMs, type ToolCallEvent, type ToolEvent } from './domain'
import { CHANGING_TOOLS, workspaceRelativePath } from './files'

/** The tools that read the file they name, and the input field that names it. */
const READING_TOOLS: Readonly<Record<string, string>> = {
  Read: 'file_path',
}

/** How the agent last touched a file. */
export enum FileTouch {
  Changed = 'changed',
  Read = 'read',
}

/** A file the agent touched, and when it last did. */
export interface TouchedFile {
  /** Relative to the workspace root. */
  readonly path: string
  /** The latest call that touched it in this way. */
  readonly at: EpochMs
  /** The id of that call, which changes whenever a new call touches the file. */
  readonly eventId: string
}

/** The files a task's agent touched: the ones it changed, and the ones it only read. Each sorted by path. */
export interface TouchedFiles {
  readonly changed: readonly TouchedFile[]
  readonly read: readonly TouchedFile[]
}

/** The empty summary: no file changed, none read. */
export const NO_TOUCHED_FILES: TouchedFiles = { changed: [], read: [] }

/**
 * The file a tool call reads or changes (Read, Write, Edit, MultiEdit, NotebookEdit), relative to the workspace root;
 * null for any other call, or a file outside the workspace.
 */
export function fileOfCall(call: Pick<ToolCallEvent, 'name' | 'input'>, rootPath: string): string | null {
  const field = CHANGING_TOOLS[call.name] ?? READING_TOOLS[call.name]
  const value = field === undefined ? undefined : call.input[field]
  return typeof value === 'string' ? workspaceRelativePath(value, rootPath) : null
}

/** The file a tool call touched, relative to the workspace root, and how; undefined for any other call. */
function touchOf(call: ToolCallEvent, rootPath: string): { path: string; touch: FileTouch } | undefined {
  const path = fileOfCall(call, rootPath)
  if (path === null) return undefined
  return { path, touch: call.name in CHANGING_TOOLS ? FileTouch.Changed : FileTouch.Read }
}

function byPath(a: TouchedFile, b: TouchedFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

/**
 * The files the agent touched, from its finished tool calls (a subagent's too): the ones it changed (Write, Edit,
 * MultiEdit, NotebookEdit) and the ones it only read. A file it read and changed counts as changed. A call still running,
 * or one that failed, touched nothing yet; nor did one on a file outside the workspace, which the Files tab can't show.
 */
export function touchedFiles(events: readonly ToolEvent[], rootPath: string): TouchedFiles {
  const changed = new Map<string, TouchedFile>()
  const read = new Map<string, TouchedFile>()
  for (const event of events) {
    if (event.kind !== ToolEventKind.ToolCall || event.state !== ToolCallState.Done) continue
    const touched = touchOf(event, rootPath)
    if (touched === undefined) continue
    const file = { path: touched.path, at: event.createdAt, eventId: event.id }
    ;(touched.touch === FileTouch.Changed ? changed : read).set(touched.path, file)
  }
  for (const path of changed.keys()) read.delete(path)
  return { changed: [...changed.values()].sort(byPath), read: [...read.values()].sort(byPath) }
}

/**
 * Two summaries of the same task's file touches over different spans of its history, one over everything (#637's
 * first load, `base`) and one over what the window has loaded of the log since (`computed`), as one: a file changed
 * by either stays changed (a later read never un-changes it), and where both agree on how it was touched, the later
 * touch stands. What the Files tab shows when the whole log isn't loaded and events keep arriving.
 */
export function mergeTouched(base: TouchedFiles, computed: TouchedFiles): TouchedFiles {
  const later = (a: TouchedFile, b: TouchedFile): TouchedFile => (a.at >= b.at ? a : b)
  const merged = new Map<string, TouchedFile>()
  for (const file of [...base.changed, ...computed.changed]) {
    const known = merged.get(file.path)
    merged.set(file.path, known === undefined ? file : later(known, file))
  }
  const read = new Map<string, TouchedFile>()
  for (const file of [...base.read, ...computed.read]) {
    if (merged.has(file.path)) continue
    const known = read.get(file.path)
    read.set(file.path, known === undefined ? file : later(known, file))
  }
  return { changed: [...merged.values()].sort(byPath), read: [...read.values()].sort(byPath) }
}
