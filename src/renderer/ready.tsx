import { useEffect, type ReactNode } from 'react'
import { READY_ATTRIBUTE } from '../shared/ready'

interface ReadySignalProps {
  /** Settles when the page has what it needs to show, e.g. when the store has hydrated. */
  readonly until?: Promise<unknown>
  readonly children: ReactNode
}

/**
 * Marks the page ready (sets `READY_ATTRIBUTE` on `<html>`) once it has rendered, `until` has settled and the fonts
 * have loaded. Only screenshot captures look for the mark; in a normal run it does nothing else.
 */
export function ReadySignal({ until, children }: ReadySignalProps): ReactNode {
  useEffect(() => {
    void Promise.allSettled([until, document.fonts.ready]).then(() => {
      document.documentElement.setAttribute(READY_ATTRIBUTE, '')
    })
  }, [until])
  return children
}
