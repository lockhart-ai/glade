/**
 * A finished turn's summary: how long it ran, and the files and lines its file-editing tool calls changed ("Finished in
 * 24m 10s · 4 files +61 −3").
 *
 * - The duration is wall-clock time, from the turn's start (its first user message) to its reply: what you waited for.
 *   A turn the app quit in and resumed on relaunch counts from when it started, not from the resume, since the SDK's
 *   own `duration_ms` only covers the resumed part.
 * - The file-editing tools are `Edit`, `MultiEdit`, `Write` and `NotebookEdit`, whether the agent or one of its
 *   subagents called them. Only calls that finished count: a failed edit changed nothing.
 * - Files are distinct paths (`file_path`, or `notebook_path` for a notebook).
 * - Lines are a line diff (the `diff` package, ignoring a missing newline at the end, since an edit's strings are
 *   fragments of a file) of each edit's old and new text. A `Write` adds every line it writes and
 *   a `NotebookEdit` every line of its new cell source: neither says what it replaced. An `Edit` with `replace_all`
 *   counts once, since its input doesn't say how many places it changed.
 */
import { diffLines } from 'diff'
import { z } from 'zod'
import { ToolCallState, ToolEventKind, type EpochMs, type ToolEvent, type TurnSummary } from '../../shared/domain'

interface LineChanges {
  readonly added: number
  readonly removed: number
}

const NO_CHANGES: LineChanges = { added: 0, removed: 0 }

/** The lines added and removed going from `before` to `after`. */
export function lineChanges(before: string, after: string): LineChanges {
  let added = 0
  let removed = 0
  for (const change of diffLines(before, after, { ignoreNewlineAtEof: true })) {
    if (change.added) added += change.count
    else if (change.removed) removed += change.count
  }
  return { added, removed }
}

function sum(changes: readonly LineChanges[]): LineChanges {
  return changes.reduce((total, change) => ({
    added: total.added + change.added,
    removed: total.removed + change.removed,
  }))
}

const replacement = z.looseObject({ old_string: z.string(), new_string: z.string() })

/** A file-editing call: the file it changed, and how. */
interface FileEdit {
  readonly path: string
  readonly changes: LineChanges
}

/** Each file-editing tool's input, read as the edit it made. */
const EDITING_TOOLS = new Map<string, z.ZodType<FileEdit>>([
  [
    'Edit',
    z
      .looseObject({ file_path: z.string(), old_string: z.string(), new_string: z.string() })
      .transform((input) => ({ path: input.file_path, changes: lineChanges(input.old_string, input.new_string) })),
  ],
  [
    'MultiEdit',
    z.looseObject({ file_path: z.string(), edits: z.array(replacement) }).transform((input) => ({
      path: input.file_path,
      changes: sum([NO_CHANGES, ...input.edits.map((edit) => lineChanges(edit.old_string, edit.new_string))]),
    })),
  ],
  [
    'Write',
    z
      .looseObject({ file_path: z.string(), content: z.string() })
      .transform((input) => ({ path: input.file_path, changes: lineChanges('', input.content) })),
  ],
  [
    'NotebookEdit',
    z
      .looseObject({ notebook_path: z.string(), new_source: z.string().optional() })
      .transform((input) => ({ path: input.notebook_path, changes: lineChanges('', input.new_source ?? '') })),
  ],
])

/** When a turn started and finished. */
export interface TurnSpan {
  /** When the turn's first user message was sent; null if it has none, and then the duration is unknown. */
  readonly startedAt: EpochMs | null
  readonly finishedAt: EpochMs
}

/** The summary of a turn that ran over `span`, from the tool log entries of that turn. */
export function summarizeTurn({ startedAt, finishedAt }: TurnSpan, toolEvents: readonly ToolEvent[]): TurnSummary {
  // A clock set back mid-turn can't make it negative.
  const durationMs = startedAt === null ? null : Math.max(0, finishedAt - startedAt)
  const files = new Set<string>()
  let added = 0
  let removed = 0
  for (const event of toolEvents) {
    if (event.kind !== ToolEventKind.ToolCall || event.state !== ToolCallState.Done) continue
    const edit = EDITING_TOOLS.get(event.name)?.safeParse(event.input)
    if (edit?.success !== true) continue
    files.add(edit.data.path)
    added += edit.data.changes.added
    removed += edit.data.changes.removed
  }
  return { durationMs, filesChanged: files.size, linesAdded: added, linesRemoved: removed }
}
