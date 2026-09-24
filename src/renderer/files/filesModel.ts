/**
 * What the Files tab shows, worked out from a task's tool log: the files the agent changed and the ones it only read,
 * relative to the workspace root, and what the viewer needs to know about each.
 */
import { ToolCallState, ToolEventKind, type EpochMs, type ToolCallEvent, type ToolEvent } from '../../shared/domain'
import { workspaceRelativePath } from '../../shared/files'

/** The tools that change the file they name, and the input field that names it. */
const CHANGING_TOOLS: Readonly<Record<string, string>> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
}

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

/** How many files the agent touched. */
export function touchedCount({ changed, read }: TouchedFiles): number {
  return changed.length + read.length
}

/** How the agent last touched a file, and when; undefined when it hasn't. */
export function touchOfFile(
  { changed, read }: TouchedFiles,
  path: string,
): { touch: FileTouch; file: TouchedFile } | undefined {
  const change = changed.find((file) => file.path === path)
  if (change !== undefined) return { touch: FileTouch.Changed, file: change }
  const reading = read.find((file) => file.path === path)
  return reading === undefined ? undefined : { touch: FileTouch.Read, file: reading }
}

/** Whether the agent changed a file. */
export function isChanged({ changed }: TouchedFiles, path: string): boolean {
  return changed.some((file) => file.path === path)
}

/** Whether a file is Markdown, which the viewer can show as a preview too. */
export function isMarkdown(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path)
}

/** A size in bytes, as the viewer's notices say it: "812 bytes", "48 KB", "2.4 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} byte${bytes === 1 ? '' : 's'}`
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
