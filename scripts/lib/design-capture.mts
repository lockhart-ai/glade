// Checks that a design screen's text actually painted before `render-design` keeps its capture, and retries the
// capture until it does. The page reports where its text is laid out (see `measureText` in scripts/render-design.mjs);
// these functions judge that report and the captured pixels. Plain functions, so they can be unit tested without
// Electron.

/** A rectangle in the screen's CSS pixels (the PNG is captured at 1x, so these are its pixels too). */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** A font face the page declares that didn't load. */
export interface FailedFont {
  family: string
  status: string
}

/** What the page says about its fonts and text, measured just before a capture. */
export interface PageReport {
  /** `document.fonts.status`: `loaded` once no font is still loading. */
  fontsStatus: string
  /** The declared font faces whose `status` isn't `loaded` after the page asked for all of them. */
  failedFonts: FailedFont[]
  /** The boxes of the visible text runs, clipped to the screen. */
  textBoxes: Box[]
  /** How many visible, non-blank text nodes have no layout box at all. */
  unlaidText: number
}

/** A captured image's raw pixels: 4 bytes per pixel, row by row (Electron's `toBitmap()` is BGRA). */
export interface Bitmap {
  width: number
  height: number
  data: Uint8Array
}

/**
 * The spread between the lightest and darkest pixel, on any channel, that counts as something drawn in a text box.
 * Glyphs on the screens' flat card colours differ from them by well over this; a box with no glyphs in it is flat.
 */
export const MIN_INK_CONTRAST = 32

/**
 * The share of text boxes that must show ink for a capture to count as painted. Not all of them do: text can sit
 * under an overlay or scrolled out of its clipping card. A capture taken before the text paints has almost none.
 */
export const MIN_INKED_SHARE = 0.8

/** Why the page isn't ready to capture: its fonts or text layout. Empty when it is. */
export function pageProblems(report: PageReport): string[] {
  const problems: string[] = []
  if (report.fontsStatus !== 'loaded') problems.push(`fonts are still ${report.fontsStatus}`)
  for (const font of report.failedFonts) problems.push(`font "${font.family}" is ${font.status}, not loaded`)
  if (report.unlaidText > 0) problems.push(`${String(report.unlaidText)} visible text nodes have no layout`)
  if (report.textBoxes.length === 0) problems.push('no text is laid out')
  return problems
}

/** Whether anything is drawn in the box: its pixels aren't all (nearly) one colour. Clipped to the bitmap. */
export function hasInk(bitmap: Bitmap, box: Box, minContrast: number = MIN_INK_CONTRAST): boolean {
  const left = Math.max(0, Math.floor(box.x))
  const top = Math.max(0, Math.floor(box.y))
  const right = Math.min(bitmap.width, Math.ceil(box.x + box.width))
  const bottom = Math.min(bitmap.height, Math.ceil(box.y + box.height))
  // Each colour channel on its own, so the byte order (BGRA or RGBA) doesn't matter; alpha is skipped.
  for (let channel = 0; channel < 3; channel++) {
    let low = 255
    let high = 0
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const value = bitmap.data[(y * bitmap.width + x) * 4 + channel] ?? 0
        low = Math.min(low, value)
        high = Math.max(high, value)
        if (high - low >= minContrast) return true
      }
    }
  }
  return false
}

/** The share of the boxes that show ink, from 0 to 1. No boxes counts as 0: there's no text to see. */
export function inkedShare(bitmap: Bitmap, boxes: readonly Box[]): number {
  if (boxes.length === 0) return 0
  return boxes.filter((box) => hasInk(bitmap, box)).length / boxes.length
}

/** Why a capture doesn't show its text. Empty when it does. */
export function captureProblems(bitmap: Bitmap, boxes: readonly Box[], width: number, height: number): string[] {
  if (bitmap.width !== width || bitmap.height !== height) {
    return [`the image is ${String(bitmap.width)}×${String(bitmap.height)}, not ${String(width)}×${String(height)}`]
  }
  const share = inkedShare(bitmap, boxes)
  if (share >= MIN_INKED_SHARE) return []
  const percent = (value: number): string => `${String(Math.round(value * 100))}%`
  return [
    `only ${percent(share)} of its ${String(boxes.length)} text boxes show text (needs ${percent(MIN_INKED_SHARE)})`,
  ]
}

/** One try at a capture: its value when it passed its checks, or why it didn't. */
export type AttemptResult<T> = { ok: true; value: T } | { ok: false; problems: string[] }

export interface RetryOptions<T> {
  /** What is being captured, for the error message. */
  label: string
  /** How many tries in all. */
  attempts: number
  /** Takes and checks one capture; `attempt` counts from 1. */
  run: (attempt: number) => Promise<AttemptResult<T>>
  /** How long to wait before the given attempt (from 2). */
  delayMs: (attempt: number) => number
  sleep: (ms: number) => Promise<void>
  /** Told about each failed attempt that will be retried. */
  onRetry?: (attempt: number, problems: string[]) => void
}

/** Raised when no attempt passed; its message lists what went wrong on each. */
export class CaptureError extends Error {
  // Plain fields, not parameter properties: Node runs this file by stripping its types, which can't rewrite those.
  readonly label: string
  readonly failures: string[][]

  constructor(label: string, failures: string[][]) {
    const lines = failures.map((problems, index) => `  attempt ${String(index + 1)}: ${problems.join('; ')}`)
    super(`${label} never rendered with its text after ${String(failures.length)} attempts:\n${lines.join('\n')}`)
    this.name = 'CaptureError'
    this.label = label
    this.failures = failures
  }
}

/** Runs `run` until an attempt passes, waiting between attempts; throws a `CaptureError` if none does. */
export async function captureWithRetries<T>(options: RetryOptions<T>): Promise<T> {
  if (options.attempts < 1) throw new RangeError(`attempts must be at least 1, not ${String(options.attempts)}`)
  const failures: string[][] = []
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    if (attempt > 1) await options.sleep(options.delayMs(attempt))
    const result = await options.run(attempt)
    if (result.ok) return result.value
    failures.push(result.problems)
    if (attempt < options.attempts) options.onRetry?.(attempt, result.problems)
  }
  throw new CaptureError(options.label, failures)
}

/** Waits longer before each retry: 250ms, 500ms, 1s, 2s, … */
export function backoffMs(attempt: number): number {
  return 250 * 2 ** (attempt - 2)
}
