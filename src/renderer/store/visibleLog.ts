/**
 * The part of a task's history its own views show (#637): a task's history loads as its last screenful and pages in
 * older as you scroll up, but the window's log also holds entries sent whole however old (the carried ones) and a
 * subagent's whole log once it loads, which can sit far older than the tail. What the task's own chat and tool log
 * show is the contiguous tail and the pages loaded onto it — the entries at or after the tail's cursor. Readers that
 * need the whole set (the Agents tab's tabs and token totals, the Todos tab, the header's reopened dot, the Files
 * tab) read the full log, as does a subagent's own tab.
 */

/** A log entry's place in its log (`Message.seq`, `ToolEvent.seq`), absent on objects made without one. */
interface Sequenced {
  readonly seq?: number
}

/** What the filter last made of a log, kept by the log's own list so a selector's answer keeps its identity. */
const kept = new WeakMap<object, { readonly before: number | null; readonly entries: readonly unknown[] }>()

/**
 * The entries of `log` at or after `before` (a cursor, `HistoryTail.messagesBefore` or `.eventsBefore`): the
 * contiguous tail and the older pages loaded onto it. `before` null — nothing of the log is loaded, or nothing older
 * is hidden — shows everything. An entry without a `seq` sorts last, and always shows.
 *
 * Kept by the log's own list, so as a selector it answers the same list while the log and the cursor stand, however
 * often it reads, and keeps every entry's object, so no row already shown renders again.
 */
export function visibleLog<T extends Sequenced>(log: readonly T[], before: number | null): readonly T[] {
  if (before === null) return log
  const read = kept.get(log)
  if (read?.before === before) return read.entries as readonly T[]
  const entries = log.filter((entry) => (entry.seq ?? Number.POSITIVE_INFINITY) >= before)
  kept.set(log, { before, entries })
  return entries
}
