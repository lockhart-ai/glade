import type { ReactNode } from 'react'
import { classNames } from '../classNames'
import { MotionPhase, usePresence } from '../../motion'
import styles from './Collapse.module.css'

export interface CollapseProps {
  /** Whether what's inside shows. */
  readonly open: boolean
  readonly children: ReactNode
  readonly className?: string
}

/** The class that opens or closes it in a phase, or none while it's still. */
function motionClass(phase: MotionPhase): string | undefined {
  switch (phase) {
    case MotionPhase.Entering:
      return styles.entering
    case MotionPhase.Leaving:
      return styles.leaving
    case MotionPhase.Shown:
    case MotionPhase.Hidden:
      return undefined
  }
}

/**
 * Something that opens and closes in place, such as a task list section's rows or a tool call's output: it grows to its
 * height and fades in, and shrinks and fades out, over `--motion-duration`. It renders nothing while closed, and what's
 * open from the start shows at once.
 */
export function Collapse({ open, children, className }: CollapseProps): React.JSX.Element | null {
  const { mounted, phase } = usePresence(open)
  if (!mounted) return null
  return (
    <div className={classNames(styles.collapse, motionClass(phase), className)} inert={phase === MotionPhase.Leaving}>
      <div className={styles.inner}>{children}</div>
    </div>
  )
}
