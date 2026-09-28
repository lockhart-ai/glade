/**
 * Unsaved edits in the Files tab, as the store keeps them: each open file's editor with what its tab shows about it,
 * and the Save / Discard / Cancel prompt that closing its tab, switching task, or closing the window or quitting with
 * unsaved edits asks first. Framework-free, like the store: the editor itself (`FileSession`, CodeMirror) is behind
 * `EditSession`.
 */
import type { FileContent } from '../../shared/domain'

/** What the Files tab shows about a file's edits: the tab's dot, and the changed-on-disk bar. */
export interface FileEditState {
  /** Whether the editor's text differs from the file on disk. */
  readonly unsaved: boolean
  /** Whether the file changed on disk under unsaved edits, and you haven't yet chosen Reload or Keep mine. */
  readonly changedOnDisk: boolean
}

/** Where an editor shows: an element of the page (kept abstract here, where there's no DOM). */
export type EditorHost = object

/**
 * A workspace file open for editing (`FileSession`): its text and its edits, which outlive the editor showing them, so
 * switching file tabs, or away from the Files tab, keeps them.
 */
export interface EditSession {
  /** What the tab shows about the edits. */
  readonly editState: FileEditState
  /** The editor's text, as saving writes it. */
  text(): string
  /** Shows the editor in `host`, as it was left; answers what takes it away again. */
  show(host: EditorHost): () => void
  /** Marks a line (from 1) and scrolls to it; null clears the mark. */
  markLine(line: number | null): void
  /**
   * Takes what's on disk now (the file was read again). Answers false when there are no unsaved edits and the disk has
   * nothing the editor can show, for the tab to show that instead.
   */
  receive(content: FileContent): boolean
  /** Reload: drops the unsaved edits for what's on disk; false when that's nothing the editor can show. */
  reload(): boolean
  /** Keep mine: keeps the edits, which the next save writes over what's on disk. */
  keepMine(): void
  /** The file was saved with `text`: the edits are measured against it now. */
  markSaved(text: string): void
}

/** Makes a file's editor, which tells `onEditState` each change to what its tab shows. */
export type OpenEditSession = (onEditState: (state: FileEditState) => void) => EditSession

/** A workspace file being edited, and what the Files tab shows about its edits. */
export interface OpenFileEdit extends FileEditState {
  readonly session: EditSession
}

/** Every file being edited, by task, then by path relative to its workspace root. */
export type FileEdits = Readonly<Record<string, Readonly<Record<string, OpenFileEdit>>>>

/** A file of a task's workspace. */
export interface TaskFile {
  readonly taskId: string
  /** Relative to the task's workspace root. */
  readonly path: string
}

/** What was about to happen when the prompt asked about unsaved edits. */
export enum UnsavedReason {
  CloseFile = 'close_file',
  SwitchTask = 'switch_task',
  CloseWindow = 'close_window',
  Quit = 'quit',
}

/** The unsaved edits prompt: what it's for, and the files with unsaved edits it's about. */
export interface UnsavedPrompt {
  readonly reason: UnsavedReason
  readonly files: readonly TaskFile[]
}

/** How you answered the prompt. */
export enum UnsavedChoice {
  /** Save the files, then go ahead. */
  Save = 'save',
  /** Drop the edits, then go ahead. */
  Discard = 'discard',
  /** Stay as you were, edits and all. */
  Cancel = 'cancel',
}

/** `edits` with a file's entry set to `edit`, or taken out for undefined. */
export function withFileEdit(edits: FileEdits, { taskId, path }: TaskFile, edit: OpenFileEdit | undefined): FileEdits {
  const others = Object.entries(edits[taskId] ?? {}).filter(([other]) => other !== path)
  if (edit === undefined) {
    return others.length === 0 ? withoutTask(edits, taskId) : { ...edits, [taskId]: Object.fromEntries(others) }
  }
  // Spread over what's there, a file (and its task) keeps its place: the prompt lists files in the order they opened.
  return { ...edits, [taskId]: { ...edits[taskId], [path]: edit } }
}

/** `edits` without a task's files. */
export function withoutTask(edits: FileEdits, taskId: string): FileEdits {
  if (!(taskId in edits)) return edits
  return Object.fromEntries(Object.entries(edits).filter(([task]) => task !== taskId))
}

/** The files with unsaved edits: a task's, or every task's when `taskId` is left out; in the order they were opened. */
export function unsavedFiles(edits: FileEdits, taskId?: string): TaskFile[] {
  const tasks = taskId === undefined ? Object.keys(edits) : [taskId]
  return tasks.flatMap((task) =>
    Object.entries(edits[task] ?? {})
      .filter(([, edit]) => edit.unsaved)
      .map(([path]) => ({ taskId: task, path })),
  )
}
