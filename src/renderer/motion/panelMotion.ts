import { MotionPhase } from './motion'
import styles from './PanelMotion.module.css'

/** The class that slides a panel open or shut in a phase (see PanelMotion.module.css), or none while it's still. */
export function panelMotionClass(phase: MotionPhase): string | undefined {
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
 * What a panel's wrapper carries while it moves: its phase, for the stylesheet to clip it by, and `inert` while it
 * leaves, so nothing on its way out takes a click or the focus.
 */
export interface PanelMotionAttributes {
  readonly 'data-motion'?: MotionPhase
  readonly inert?: boolean
}

export function panelMotionAttributes(phase: MotionPhase): PanelMotionAttributes {
  switch (phase) {
    case MotionPhase.Entering:
      return { 'data-motion': phase }
    case MotionPhase.Leaving:
      return { 'data-motion': phase, inert: true }
    case MotionPhase.Shown:
    case MotionPhase.Hidden:
      return {}
  }
}
