// How things animate as they come and go (docs/design/tokens.md, Motion). The CSS does the animating, on the motion
// tokens; this keeps something on screen while it animates out, and says which way it's moving.
import { useEffect, useState } from 'react'

/** Where something that animates in and out is. */
export enum MotionPhase {
  /** Animating in. */
  Entering = 'entering',
  /** In, and still. */
  Shown = 'shown',
  /** Animating out: still on screen, but on its way. */
  Leaving = 'leaving',
  /** Out: not on screen. */
  Hidden = 'hidden',
}

/** The token every movement lasts, which Reduce motion sets to 0 (src/renderer/tokens.css). */
export const MOTION_DURATION_PROPERTY = '--motion-duration'

/** A CSS time such as `200ms` or `0.2s`, in milliseconds; anything else is 0. */
export function parseDuration(value: string): number {
  const match = /^(\d*\.?\d+)(ms|s)$/.exec(value.trim())
  if (match === null) return 0
  const amount = Number(match[1])
  return match[2] === 's' ? amount * 1000 : amount
}

/**
 * How long a movement lasts now, in milliseconds: the `--motion-duration` token, which is 0 with Reduce motion on (and
 * wherever the stylesheet isn't loaded, as in unit tests).
 */
export function motionDuration(): number {
  return parseDuration(getComputedStyle(document.documentElement).getPropertyValue(MOTION_DURATION_PROPERTY))
}

/** Whether a phase is a movement in progress. */
export function isMoving(phase: MotionPhase): boolean {
  switch (phase) {
    case MotionPhase.Entering:
    case MotionPhase.Leaving:
      return true
    case MotionPhase.Shown:
    case MotionPhase.Hidden:
      return false
  }
}

/** Whether to render something that animates in and out, and where it is. */
export interface Presence {
  /** Whether it's on screen: shown, or on its way in or out. */
  readonly mounted: boolean
  readonly phase: MotionPhase
}

/** The phase something moves to when it's shown or hidden: straight there when nothing moves. */
function nextPhase(shown: boolean): MotionPhase {
  const moves = motionDuration() > 0
  if (shown) return moves ? MotionPhase.Entering : MotionPhase.Shown
  return moves ? MotionPhase.Leaving : MotionPhase.Hidden
}

/**
 * Keeps something on screen while it animates out. Given whether it should be shown, it says whether to render it and
 * which way it's moving, for the CSS to animate by: it enters for `--motion-duration` when shown, and when hidden it
 * stays mounted, leaving, for as long again. With Reduce motion on it's shown and hidden at once.
 */
export function usePresence(shown: boolean): Presence {
  // What's there from the start stays put: only a change animates.
  const [phase, setPhase] = useState(shown ? MotionPhase.Shown : MotionPhase.Hidden)
  const [wasShown, setWasShown] = useState(shown)

  // Shown or hidden: start moving. Done while rendering (React's pattern for adjusting state when a prop changes), so
  // it starts in the same commit.
  if (shown !== wasShown) {
    setWasShown(shown)
    setPhase(nextPhase(shown))
  }

  useEffect(() => {
    if (!isMoving(phase)) return
    const timer = setTimeout(() => {
      setPhase(phase === MotionPhase.Entering ? MotionPhase.Shown : MotionPhase.Hidden)
    }, motionDuration())
    return () => {
      clearTimeout(timer)
    }
  }, [phase])

  return { mounted: phase !== MotionPhase.Hidden, phase }
}
