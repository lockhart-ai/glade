/**
 * Temporary instrumentation for #637 (the switch-latency spike): counts how many times a kind of row renders, so a
 * spec can tell whether a switch re-renders rows whose own data didn't change (e.g. every task row, not just the one
 * that was selected and the one that was deselected). Not a fix, and not meant to be kept.
 */

declare global {
  interface Window {
    __rowRenders?: Record<string, number>
  }
}

export function countRowRender(kind: string): void {
  if (typeof window === 'undefined') return
  window.__rowRenders ??= {}
  window.__rowRenders[kind] = (window.__rowRenders[kind] ?? 0) + 1
}
