/**
 * Temporary instrumentation for #637 (the switch-latency spike): a React `Profiler.onRender` that records each
 * commit's timing onto `window`, for `e2e/637-switch-latency.spec.ts` to read back. Not a fix, and not meant to be
 * kept once the issue's follow-up PRs land.
 */
import type { ProfilerOnRenderCallback } from 'react'

export interface SwitchRenderRecord {
  readonly id: string
  readonly phase: string
  readonly actualDuration: number
  readonly baseDuration: number
  readonly startTime: number
  readonly commitTime: number
}

declare global {
  interface Window {
    __switchRenders?: SwitchRenderRecord[]
  }
}

export const recordRender: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  baseDuration,
  startTime,
  commitTime,
) => {
  if (typeof window === 'undefined' || window.__switchRenders === undefined) return
  window.__switchRenders.push({ id, phase, actualDuration, baseDuration, startTime, commitTime })
}
