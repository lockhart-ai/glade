import { useEffect, useState } from 'react'
import type { EpochMs } from '../../shared/domain'

/** How often relative times are refreshed. */
export const NOW_REFRESH_MS = 30_000

/** The current time, refreshed every `NOW_REFRESH_MS`, so relative times ("4m") move on while nothing else changes. */
export function useNow(): EpochMs {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
    }, NOW_REFRESH_MS)
    return () => {
      clearInterval(timer)
    }
  }, [])
  return now
}
