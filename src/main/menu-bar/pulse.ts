/**
 * The menu bar icon's pulse (`docs/design/html/29-menu-bar.html`): while any agent works, the glyph steps through a
 * few frames of itself at lower strength, and back, on a timer. It's the menu bar's version of the working line's
 * dots (`docs/design/tokens.md`, Motion): one round every 7 × `motion-duration`, 1.4s.
 */

/**
 * The strengths the glyph is drawn at, as its frames: the first is the glyph as it is, idle or not; each image is
 * `assets/icon/menu-bar/glyph-<index>Template.png`. `scripts/make-menu-bar-icons.sh` draws them.
 */
export const GLYPH_STRENGTHS: readonly number[] = [1, 0.78, 0.55]

/** The frames one round of the pulse shows, in order, as indexes into `GLYPH_STRENGTHS`: down and back up. */
export const PULSE_SEQUENCE: readonly number[] = [0, 1, 2, 1]

/** How long each frame of the pulse shows: four of them make a 1.4s round. */
export const PULSE_FRAME_MS = 350

/** The glyph at full strength: the idle icon's, and where the pulse rests. */
export const RESTING_FRAME = 0

/** Pulses the icon on and off. */
export interface Pulse {
  /** Starts the pulse, or stops it and rests the glyph. Setting it as it already is changes nothing. */
  set(on: boolean): void
  /** Whether it's pulsing. */
  readonly on: boolean
}

/** A pulse that draws each frame with `setFrame`, an index into `GLYPH_STRENGTHS`. */
export function createPulse(setFrame: (frame: number) => void): Pulse {
  let timer: ReturnType<typeof setInterval> | null = null
  let step = 0
  return {
    get on() {
      return timer !== null
    },
    set(on) {
      if (on === (timer !== null)) return
      if (timer !== null) {
        clearInterval(timer)
        timer = null
        setFrame(RESTING_FRAME)
        return
      }
      step = 0
      timer = setInterval(() => {
        step = (step + 1) % PULSE_SEQUENCE.length
        setFrame(PULSE_SEQUENCE[step] ?? RESTING_FRAME)
      }, PULSE_FRAME_MS)
    },
  }
}
