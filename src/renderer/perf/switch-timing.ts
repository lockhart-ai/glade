/**
 * Temporary instrumentation for #637 (the switch-latency spike): marks the renderer's side of a task or workspace
 * switch (the click, the store's steps, the reducer) onto `window`, for `e2e/637-switch-latency.spec.ts` to read back.
 * Not a fix, and not meant to be kept once the issue's follow-up PRs land.
 *
 * `store.ts` is framework-free (its own integration test runs it under Node, against the real main process, with no
 * DOM — `tsconfig.node.json`'s comment on `src/renderer/store/*.ts`), so this reaches `window` through `globalThis`,
 * cast through a local type, rather than the ambient DOM `Window` type store.ts can't assume is there.
 */

export interface SwitchMark {
  readonly name: string
  /** `performance.now()`: comparable to other marks in this window, not to main's `Date.now()` timestamps. */
  readonly at: number
  /** `Date.now()`, for marks a spec lines up against main's own `Date.now()` timestamps (`__switchTimings`). */
  readonly wallClock: number
  readonly extra?: Readonly<Record<string, number>>
}

interface SwitchGlobals {
  __switchMarks?: SwitchMark[]
  /** #637 spike: an opt-in experiment, set by a spec before a click, that skips reloading an already-loaded task. */
  __skipReloadIfCached?: boolean
}

function switchGlobals(): SwitchGlobals | undefined {
  return typeof globalThis === 'undefined' ? undefined : (globalThis as unknown as SwitchGlobals)
}

/** Appends a mark, if anything is listening (a spec sets up `__switchMarks` before it cares). */
export function mark(name: string, extra?: Readonly<Record<string, number>>): void {
  const globals = switchGlobals()
  if (globals?.__switchMarks === undefined) return
  globals.__switchMarks.push({ name, at: performance.now(), wallClock: Date.now(), ...(extra && { extra }) })
}

/** Whether a spec has turned the "skip an already-cached task's reload" experiment on. */
export function skipReloadIfCached(): boolean {
  return switchGlobals()?.__skipReloadIfCached === true
}
