import { useEffect, useState } from 'react'
import type { EpochMs } from '../../shared/domain'
import { NOW_REFRESH_MS } from '../task-list/useNow'

/** How often a time that reads in seconds is refreshed. */
export const SECONDS_REFRESH_MS = 1000

const MINUTE = 60_000

/**
 * The current time, for saying how long something that started at `since` has run (`formatDuration`): refreshed every
 * second through its first minute, while it reads in seconds, and every `NOW_REFRESH_MS` from then on, when it reads
 * in minutes. Null stops refreshing it: it has finished, and how long it ran no longer changes.
 *
 * Whatever shows the time keeps this clock itself, so a tick renders that element and nothing around it.
 */
export function useElapsedNow(since: EpochMs | null): EpochMs {
  const [now, setNow] = useState(Date.now)
  const inSeconds = since !== null && now - since < MINUTE
  useEffect(() => {
    if (since === null) return
    const timer = setInterval(
      () => {
        setNow(Date.now())
      },
      inSeconds ? SECONDS_REFRESH_MS : NOW_REFRESH_MS,
    )
    return () => {
      clearInterval(timer)
    }
  }, [since, inSeconds])
  return now
}
