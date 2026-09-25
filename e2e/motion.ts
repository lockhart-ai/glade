/**
 * Watches the app's animations from inside the page (docs/design/tokens.md, Motion), so a spec can check what animated
 * without timing anything: every CSS animation that starts, with its duration, and every `data-motion` phase a panel
 * shows while it slides. The page records them as they happen; the spec reads them once the change has landed.
 */
import type { Page } from '@playwright/test'

/** A CSS animation that started: its name (as the stylesheet's module scoped it) and its duration in milliseconds. */
export interface StartedAnimation {
  readonly name: string
  readonly duration: number
}

/** What moved since `watchMotion` or the last `takeMotion`. */
export interface MotionRecord {
  readonly animations: readonly StartedAnimation[]
  /** Each `data-motion` phase shown, in order: `entering` or `leaving`. */
  readonly phases: readonly string[]
}

/** Where the page keeps its record. */
const RECORD = '__gladeMotion'

/** Starts recording what animates. Call it once per launch, before the changes to watch. */
export async function watchMotion(window: Page): Promise<void> {
  await window.evaluate((key) => {
    const record: { animations: StartedAnimation[]; phases: string[] } = { animations: [], phases: [] }
    Reflect.set(window, key, record)
    // The window is never shown, so it paints (and fires animation events) only now and then: an animation can be over,
    // and what it animated gone, before a frame. So each change to the page is checked for the animations it started.
    const seen = new WeakSet<Animation>()
    const noteAnimations = (): void => {
      for (const animation of document.getAnimations()) {
        // An endless animation (the working line's pulsing dots) is no change of state, so it isn't one to record.
        if (!(animation instanceof CSSAnimation) || seen.has(animation)) continue
        if (animation.effect?.getComputedTiming().iterations === Infinity) continue
        seen.add(animation)
        const duration = animation.effect?.getComputedTiming().duration
        record.animations.push({ name: animation.animationName, duration: typeof duration === 'number' ? duration : 0 })
      }
    }
    const notePhase = (element: Element): void => {
      const phase = element.getAttribute('data-motion')
      if (phase !== null) record.phases.push(phase)
    }
    noteAnimations()
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'data-motion') {
          if (mutation.target instanceof Element) notePhase(mutation.target)
        }
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue
          notePhase(node)
          node.querySelectorAll('[data-motion]').forEach(notePhase)
        }
      }
      noteAnimations()
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-motion', 'class'],
    })
  }, RECORD)
}

/** What animated since the last call (or `watchMotion`), and starts afresh. */
export async function takeMotion(window: Page): Promise<MotionRecord> {
  return window.evaluate((key) => {
    const record: unknown = Reflect.get(window, key)
    if (typeof record !== 'object' || record === null) throw new Error('watchMotion first')
    const { animations, phases } = record as { animations: StartedAnimation[]; phases: string[] }
    const taken = { animations: [...animations], phases: [...phases] }
    animations.length = 0
    phases.length = 0
    return taken
  }, RECORD)
}

/**
 * The CSS animations running in the page now that take something from one state to another: not transitions, such as a
 * hover's colour, and not endless ones, such as the working line's pulsing dots.
 */
export function runningAnimations(window: Page): Promise<number> {
  return window.evaluate(
    () =>
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation instanceof CSSAnimation && animation.effect?.getComputedTiming().iterations !== Infinity,
        ).length,
  )
}

/** The animations in a record whose name has `name` in it (e.g. `panel-close`), with their durations. */
export function durationsOf(record: MotionRecord, name: string): readonly number[] {
  return record.animations.filter((animation) => animation.name.includes(name)).map(({ duration }) => duration)
}
