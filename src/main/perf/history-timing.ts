/**
 * Temporary instrumentation for #674 (the paint-timing spike): records how long `TasksHistory`'s handler
 * (`src/main/bridge/handlers.ts`) spent listing a task's *whole* chat and tool log, before slicing both down to the
 * last page it actually sends — the part of a task switch a renderer-side timer can't see. Active only under
 * `GLADE_E2E` (never in a real run, and even then a no-op until a spec reads `globalThis.__historyTimings`), which
 * `e2e/paint-timing.spec.ts` reads with `inMain`.
 *
 * Not a fix, and not meant to be kept: a fix would page these two queries at the DB layer the way
 * `tasks.historyBefore` already does (`LIMIT` and `ORDER BY seq DESC`), instead of listing every row a task has ever
 * had and slicing the last `HISTORY_PAGE` of them in JS.
 */
import { E2E_ENV } from '../e2e'

export interface HistoryTimingRecord {
  readonly taskId: string
  readonly messageCount: number
  readonly eventCount: number
  readonly listMessagesMs: number
  readonly listToolEventsMs: number
  readonly totalMs: number
}

declare global {
  var __historyTimings: HistoryTimingRecord[] | undefined
}

/** Appends a record, only while this process is an e2e run (`GLADE_E2E`); a no-op in a real launch. */
export function recordHistoryTiming(record: HistoryTimingRecord): void {
  if (process.env[E2E_ENV] === undefined) return
  globalThis.__historyTimings = [...(globalThis.__historyTimings ?? []), record]
}
