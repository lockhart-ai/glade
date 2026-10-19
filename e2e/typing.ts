// Shared helpers for the long-history typing specs: CI's `typing-latency.spec.ts` types at a steady pace and checks
// every keystroke lands, with no duration asserted (#746); the stress spec `stress/typing-paint.spec.ts` measures each
// key's time to the screen the same way, prints the medians and holds the budget.
import type { Page } from '@playwright/test'

/** A key every 60 ms: fast typing, about 200 words a minute. */
export const PACE_MS = 60
export const TEXT = 'the quick brown fox jumps over the lazy dog'

/**
 * The slowest a key may be to show, at the median, held only by the stress spec (`stress/typing-paint.spec.ts`):
 * generous, for a slow CI runner. It took 2 to 8 ms after the fix on the machine that measured it, and 400 to 1,100 ms
 * before it while the agent worked. CI's specs assert no duration (Jared, #746).
 */
export const MEDIAN_LIMIT_MS = 150

/** A key as the page saw it: when it was pressed, and when the frame after it had been drawn. */
export interface KeySample {
  readonly at: number
  paint: number | null
}

interface MeasuredWindow {
  __keys?: KeySample[]
}

/** Starts recording each keydown's time and the end of the frame that follows it. Call it once per test. */
export async function recordKeys(window: Page): Promise<void> {
  await window.evaluate(() => {
    const keys: KeySample[] = []
    ;(globalThis as MeasuredWindow).__keys = keys
    document.addEventListener(
      'keydown',
      (event) => {
        const key: KeySample = { at: event.timeStamp, paint: null }
        keys.push(key)
        // A message posted from the next animation frame is handled once that frame has been drawn.
        requestAnimationFrame(() => {
          const channel = new MessageChannel()
          channel.port1.onmessage = () => {
            key.paint = performance.now()
          }
          channel.port2.postMessage(null)
        })
      },
      { capture: true },
    )
  })
}

/** Types `text` at a steady pace, without waiting on the window between keys, as a person does. */
export async function typeText(window: Page, text: string): Promise<void> {
  const presses: Promise<void>[] = []
  for (const char of text) {
    presses.push(window.keyboard.press(char === ' ' ? 'Space' : char))
    await new Promise((resolve) => setTimeout(resolve, PACE_MS))
  }
  await Promise.all(presses)
}

/**
 * Types `text` at a steady pace and answers each key's time to the screen, in milliseconds, in order of size. The
 * keys are recorded by `recordKeys`, called once before the first measured round.
 */
export async function typeAndMeasure(window: Page, text: string): Promise<number[]> {
  await window.evaluate(() => {
    ;(globalThis as MeasuredWindow).__keys?.splice(0)
  })
  await typeText(window, text)
  await window.waitForFunction((count) => {
    const keys = (globalThis as MeasuredWindow).__keys ?? []
    return keys.length === count && keys.every(({ paint }) => paint !== null)
  }, text.length)
  const latencies = await window.evaluate(() =>
    ((globalThis as MeasuredWindow).__keys ?? []).map(({ at, paint }) => (paint ?? at) - at),
  )
  return latencies.sort((a, b) => a - b)
}

/** The middle of `sorted` (ascending). */
export function median(sorted: readonly number[]): number {
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}
