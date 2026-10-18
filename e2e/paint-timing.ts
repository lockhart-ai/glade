// Generic test-only timing for #674 (find the biggest waits before Glade paints what was asked for): times an
// action from the moment it lands to the frame after the result's own content shows ("first paint") and, when a view
// loads more after that on its own, to the frame after it settles ("fully loaded"). Modelled on
// `e2e/history-tail.spec.ts`'s `__switch` timer (#637, #654): a predicate must check for the new content's own
// element or an exact value, never a bare "something changed" — identical seeded text across two long tasks once
// fooled a plain text check (#654).
//
// `readySrc` and `settledSrc` are JavaScript boolean expressions (not functions), evaluated with no arguments in the
// page — e.g. `document.querySelector('h1')?.textContent === "Foo"` — so a call site can bake in whatever literal
// values it needs with a template literal, and the same expression can be used both to arm a click listener (precise,
// from the DOM event's own timestamp) and to `page.waitForFunction` (for an action with no click of its own, like a
// native menu item).
import type { Page } from '@playwright/test'

export interface PaintSample {
  /** From the action to the frame after the result's own content first showed. */
  readonly firstPaintMs: number
  /** From the action to the frame after nothing more loaded on its own; falls back to `firstPaintMs` when nothing
   * past first paint ever matches `settledSrc` within the timeout (the two are the same action, in this app). */
  readonly fullyLoadedMs: number
}

interface RawSample {
  at: number
  paint: number | null
  settled: number | null
  /** Set once if `readySrc` or `settledSrc` ever throws, so a failure reads as "why", not just "timed out". */
  error?: string
}

interface PaintGlobals {
  __paint?: RawSample
}

/** How long a settle may take before `readPaintTimer` gives up and reports `fullyLoadedMs` as `firstPaintMs`. */
const DEFAULT_SETTLE_TIMEOUT_MS = 10_000

/** A DOM event Playwright's own action dispatches as a trusted event: a click, or the last key of a typed string. */
export type TriggerEventType = 'click' | 'keydown'

/**
 * Arms the next `eventType` event anywhere in the page: records its DOM timestamp, then polls (one
 * `requestAnimationFrame` at a time, so it never runs ahead of the browser's own paint) for `readySrc`, then for
 * `settledSrc`, marking each two frames and a posted message after it first turns true — the same margin
 * `history-tail.spec.ts` gives a switch's paint, which a single `requestAnimationFrame` sometimes lands just before.
 */
export async function armPaintTimer(
  window: Page,
  readySrc: string,
  settledSrc: string,
  eventType: TriggerEventType = 'click',
): Promise<void> {
  await window.evaluate(
    ({ readySrc, settledSrc, eventType }) => {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the only way to run a call site's own string.
      const isReady = new Function(`return (${readySrc})`) as () => boolean
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const isSettled = new Function(`return (${settledSrc})`) as () => boolean
      const globals = globalThis as unknown as PaintGlobals
      globals.__paint = { at: 0, paint: null, settled: null }
      const sample = globals.__paint
      // A throwing predicate (a selector that doesn't exist yet, say) would otherwise abort the whole
      // `requestAnimationFrame` chain silently, reading as a plain timeout with no clue why.
      const guarded = (predicate: () => boolean): boolean => {
        try {
          return predicate()
        } catch (error) {
          sample.error = error instanceof Error ? error.message : String(error)
          return false
        }
      }
      const twoFramesLater = (done: () => void): void => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const channel = new MessageChannel()
            channel.port1.onmessage = () => {
              done()
            }
            channel.port2.postMessage(null)
          })
        })
      }
      document.addEventListener(
        eventType,
        (event) => {
          sample.at = event.timeStamp
          const pollReady = (): void => {
            if (!guarded(isReady)) {
              requestAnimationFrame(pollReady)
              return
            }
            twoFramesLater(() => {
              sample.paint = performance.now()
              const pollSettled = (): void => {
                if (!guarded(isSettled)) {
                  requestAnimationFrame(pollSettled)
                  return
                }
                twoFramesLater(() => {
                  sample.settled = performance.now()
                })
              }
              requestAnimationFrame(pollSettled)
            })
          }
          requestAnimationFrame(pollReady)
        },
        { capture: true, once: true },
      )
    },
    { readySrc, settledSrc, eventType },
  )
}

/** Reads back an armed timer: waits for its paint, then (up to `settleTimeoutMs`) for its settle, and answers both. */
export async function readPaintTimer(
  window: Page,
  settleTimeoutMs: number = DEFAULT_SETTLE_TIMEOUT_MS,
): Promise<PaintSample> {
  try {
    await window.waitForFunction(() => ((globalThis as unknown as PaintGlobals).__paint?.paint ?? null) !== null)
  } catch (error) {
    const { readyError } = await window.evaluate(() => ({
      readyError: (globalThis as unknown as PaintGlobals).__paint?.error ?? null,
    }))
    if (readyError !== null) throw new Error(`readySrc threw: ${readyError}`)
    throw error
  }
  try {
    await window.waitForFunction(
      () => ((globalThis as unknown as PaintGlobals).__paint?.settled ?? null) !== null,
      undefined,
      { timeout: settleTimeoutMs },
    )
  } catch {
    // Nothing past first paint ever matched settledSrc: fullyLoadedMs falls back to firstPaintMs below.
  }
  const { at, paint, settled } = await window.evaluate(() => {
    const sample = (globalThis as unknown as PaintGlobals).__paint
    return { at: sample?.at ?? 0, paint: sample?.paint ?? 0, settled: sample?.settled ?? null }
  })
  return { firstPaintMs: paint - at, fullyLoadedMs: (settled ?? paint) - at }
}

/** Arms the timer, runs `click` (which must land exactly one DOM click), and reads the result. */
export async function timeClick(
  window: Page,
  click: () => Promise<void>,
  readySrc: string,
  settledSrc: string = readySrc,
  settleTimeoutMs: number = DEFAULT_SETTLE_TIMEOUT_MS,
): Promise<PaintSample> {
  await armPaintTimer(window, readySrc, settledSrc, 'click')
  await click()
  return readPaintTimer(window, settleTimeoutMs)
}

/** Arms the timer for the next keydown, runs `press` (which must land exactly one key), and reads the result. */
export async function timeKeyPress(
  window: Page,
  press: () => Promise<void>,
  readySrc: string,
  settledSrc: string = readySrc,
  settleTimeoutMs: number = DEFAULT_SETTLE_TIMEOUT_MS,
): Promise<PaintSample> {
  await armPaintTimer(window, readySrc, settledSrc, 'keydown')
  await press()
  return readPaintTimer(window, settleTimeoutMs)
}

/**
 * Waits for `predicateSrc` (a boolean expression, as `armPaintTimer`'s) to turn true, the CSP-safe way: Glade's
 * window runs under a strict `script-src 'self'` with no `unsafe-eval`, which allows `new Function` built *once*,
 * synchronously, inside a single `page.evaluate` call (CDP's `Runtime.callFunctionOn` runs that whole call outside
 * the page's own CSP-checked script, the same reason `armPaintTimer`'s click handler can build and call `isReady`
 * freely) but not `page.waitForFunction`'s own retry loop, which re-evaluates its predicate *as text* on every poll,
 * each one outside that first privileged call — so this does its own `requestAnimationFrame` polling, entirely
 * inside the one `evaluate`, the same shape as `armPaintTimer`'s. Playwright's docs don't spell out this gap; it only
 * showed up once a spec here tried `waitForFunction` with a raw predicate string.
 */
interface PredicateGlobal {
  __predicate?: () => boolean
}

async function waitForPredicate(window: Page, predicateSrc: string, timeoutMs = 10_000): Promise<void> {
  // Builds the predicate function once, synchronously, inside this one `evaluate` call (the privileged step), and
  // stashes it on a global; `page.waitForFunction` below then polls a plain arrow function with no `eval` of its
  // own, driven by Playwright's own (proven-reliable) retry loop, on main's side, each poll a fresh short call
  // rather than one long-lived in-page promise. (An earlier version did its own `requestAnimationFrame` polling
  // inside one long-lived `evaluate`-returned promise; it silently never saw the DOM settle, for a reason this
  // rewrite didn't chase down further — `page.waitForFunction` already does this correctly elsewhere in this file.)
  await window.evaluate((src) => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the only way to run a call site's own string.
    ;(globalThis as unknown as PredicateGlobal).__predicate = new Function(`return (${src})`) as () => boolean
  }, predicateSrc)
  await window.waitForFunction(() => (globalThis as unknown as PredicateGlobal).__predicate?.() ?? false, undefined, {
    timeout: timeoutMs,
  })
}

/**
 * Times an action with no DOM click of its own — a native menu item chosen through `chooseMenuItem`, which main
 * clicks directly, or a widget that unmounts on its own click before the browser would dispatch a native `click`
 * event for it (#674's own gotcha: `measureTaskAndWorkspaceSwitches`' workspace row) — in wall-clock milliseconds in
 * Node around it, polling `readySrc` and `settledSrc` with `waitForPredicate`. Coarser than `timeClick` (it carries
 * at least one IPC round trip on both ends) but the only way to time what Playwright never sees as a click.
 */
export async function timeMenuAction(
  window: Page,
  trigger: () => Promise<void>,
  readySrc: string,
  settledSrc: string = readySrc,
  settleTimeoutMs: number = DEFAULT_SETTLE_TIMEOUT_MS,
  readyTimeoutMs: number = DEFAULT_SETTLE_TIMEOUT_MS,
): Promise<PaintSample> {
  const start = Date.now()
  await trigger()
  await waitForPredicate(window, readySrc, readyTimeoutMs)
  const paintAt = Date.now()
  try {
    await waitForPredicate(window, settledSrc, settleTimeoutMs)
  } catch {
    // as armPaintTimer's: fullyLoadedMs falls back to firstPaintMs below.
  }
  const settledAt = Date.now()
  return { firstPaintMs: paintAt - start, fullyLoadedMs: settledAt - start }
}

/** The middle of `sorted` (ascending): `samples.length` medians over a spec's repeat runs land here. */
export function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}
