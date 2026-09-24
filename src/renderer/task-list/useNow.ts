import { useEffect, useState } from 'react'
import type { EpochMs } from '../../shared/domain'

/** How often relative times are refreshed. */
export const NOW_REFRESH_MS = 30_000

/**
 * The current time, refreshed every `refreshMs` (`NOW_REFRESH_MS` unless given), so relative times ("4m") move on
 * while nothing else changes. A `refreshMs` of null stops refreshing it, e.g. while nothing shown depends on it.
 */
export function useNow(refreshMs: number | null = NOW_REFRESH_MS): EpochMs {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (refreshMs === null) return
    const timer = setInterval(() => {
      setNow(Date.now())
    }, refreshMs)
    return () => {
      clearInterval(timer)
    }
  }, [refreshMs])
  return now
}
