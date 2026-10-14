/**
 * Temporary instrumentation for #637 (the switch-latency spike): records, in main, how long `TasksHistory` spent on
 * each of its queries, the whole handler's time, and the size and shape of what it sent back. Nothing reads this in
 * the shipped app; `e2e/637-switch-latency.spec.ts` pulls it out with `inMain`. Not a fix, and not meant to be kept
 * once the issue's follow-up PRs land (`docs/kitten-sop.md`'s stop rule: measure, don't change).
 */

export interface SwitchTimingStep {
  readonly name: string
  readonly ms: number
}

export interface SwitchTimingRecord {
  readonly taskId: string
  /** Wall-clock time the handler started, so a spec can line it up with the renderer's own `Date.now()` marks. */
  readonly receivedAt: number
  readonly respondedAt: number
  readonly steps: readonly SwitchTimingStep[]
  readonly totalMs: number
  /** `JSON.stringify(result).length`, in bytes (UTF-8): a proxy for what crosses the IPC boundary. */
  readonly bytes: number
  readonly rowCounts: Readonly<Record<string, number>>
}

/** A plain command's own time in main, with when it was received: `UiStateSet` and `WorkspacesOpen`. */
export interface CommandTimingRecord {
  readonly name: string
  readonly receivedAt: number
  readonly respondedAt: number
  readonly ms: number
}

declare global {
  // A global a spec reads with `inMain`; see the file comment above. `__capHistoryMessages` is an opt-in experiment
  // a spec sets with `inMain` (see handlers.ts).

  var __switchTimings: SwitchTimingRecord[] | undefined

  var __capHistoryMessages: number | undefined

  var __commandTimings: CommandTimingRecord[] | undefined
}

/** Appends a record of one `TasksHistory` call. */
export function recordSwitchTiming(record: SwitchTimingRecord): void {
  globalThis.__switchTimings = [...(globalThis.__switchTimings ?? []), record]
}

/** Times a plain command's own handler (one not already broken into steps), recording it like `recordSwitchTiming`. */
export function timeCommand<T>(name: string, fn: () => T): T {
  const receivedAt = Date.now()
  const start = performance.now()
  const result = fn()
  const ms = performance.now() - start
  globalThis.__commandTimings = [
    ...(globalThis.__commandTimings ?? []),
    { name, receivedAt, respondedAt: Date.now(), ms },
  ]
  return result
}

/** Times `fn`, in milliseconds, with its result. */
export function timeStep<T>(steps: SwitchTimingStep[], name: string, fn: () => T): T {
  const start = performance.now()
  const result = fn()
  steps.push({ name, ms: performance.now() - start })
  return result
}
