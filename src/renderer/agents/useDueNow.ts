import { useEffect, useState } from 'react'
import type { EpochMs } from '../../shared/domain'
import { NOW_REFRESH_MS } from '../task-list/useNow'
import { SECONDS_REFRESH_MS } from './useElapsedNow'

/** How close to its time something due reads in seconds ("Due in 42s"): refreshed every second from a little before. */
export const DUE_SOON_MS = 90_000

/**
 * The current time, for saying how long until something is due at `at` (`formatDueIn`): refreshed every
 * `NOW_REFRESH_MS` while that reads in minutes, and every second around its time, when it reads in seconds. Null stops
 * refreshing it: nothing is due.
 *
 * Whatever shows the time keeps this clock itself, so a tick renders that element and nothing around it.
 */
export function useDueNow(at: EpochMs | null): EpochMs {
  const [now, setNow] = useState(Date.now)
  const soon = at !== null && Math.abs(at - now) < DUE_SOON_MS
  useEffect(() => {
    if (at === null) return
    const timer = setInterval(
      () => {
        setNow(Date.now())
      },
      soon ? SECONDS_REFRESH_MS : NOW_REFRESH_MS,
    )
    return () => {
      clearInterval(timer)
    }
  }, [at, soon])
  return now
}
