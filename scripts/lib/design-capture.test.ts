import { describe, expect, it, vi } from 'vitest'
import {
  type AttemptResult,
  type Bitmap,
  type Box,
  type PageReport,
  backoffMs,
  captureProblems,
  CaptureError,
  captureWithRetries,
  hasInk,
  inkedShare,
  MIN_INK_CONTRAST,
  pageProblems,
} from './design-capture.mjs'

/** The screens' page background, #0A0B0F, as BGRA. */
const BACKGROUND = [0x0f, 0x0b, 0x0a, 0xff]

/** A bitmap filled with one colour. */
function flat(width: number, height: number, bgra: number[] = BACKGROUND): Bitmap {
  const data = new Uint8Array(width * height * 4)
  for (let pixel = 0; pixel < width * height; pixel++) data.set(bgra, pixel * 4)
  return { width, height, data }
}

/** Paints one pixel, as a glyph's stroke would. */
function paint(bitmap: Bitmap, x: number, y: number, bgra: number[]): void {
  bitmap.data.set(bgra, (y * bitmap.width + x) * 4)
}

/** Paints a "glyph" (a light pixel) in the middle of each box. */
function write(bitmap: Bitmap, boxes: readonly Box[], bgra: number[] = [0xf0, 0xe8, 0xe6, 0xff]): void {
  for (const box of boxes) {
    paint(bitmap, Math.floor(box.x + box.width / 2), Math.floor(box.y + box.height / 2), bgra)
  }
}

const readyReport: PageReport = {
  fontsStatus: 'loaded',
  failedFonts: [],
  textBoxes: [{ x: 0, y: 0, width: 10, height: 10 }],
  unlaidText: 0,
}

/** Ten text boxes in a row, 10×8 each, on a 100×10 screen. */
const BOXES: Box[] = Array.from({ length: 10 }, (_, index) => ({ x: index * 10, y: 1, width: 10, height: 8 }))

describe('pageProblems', () => {
  it('passes a page whose fonts loaded and whose text is laid out', () => {
    expect(pageProblems(readyReport)).toEqual([])
  })

  it('fails while the fonts are still loading', () => {
    expect(pageProblems({ ...readyReport, fontsStatus: 'loading' })).toEqual(['fonts are still loading'])
  })

  it('names each font that failed to load', () => {
    const report: PageReport = {
      ...readyReport,
      failedFonts: [
        { family: 'Geist', status: 'error' },
        { family: '"Geist Mono"', status: 'unloaded' },
      ],
    }
    expect(pageProblems(report)).toEqual([
      'font "Geist" is error, not loaded',
      'font ""Geist Mono"" is unloaded, not loaded',
    ])
  })

  it('fails when visible text has no layout', () => {
    expect(pageProblems({ ...readyReport, unlaidText: 3 })).toEqual(['3 visible text nodes have no layout'])
  })

  it('fails a page with no text laid out at all', () => {
    expect(pageProblems({ ...readyReport, textBoxes: [] })).toEqual(['no text is laid out'])
  })

  it('lists every problem at once', () => {
    const report: PageReport = { fontsStatus: 'loading', failedFonts: [], textBoxes: [], unlaidText: 1 }
    expect(pageProblems(report)).toHaveLength(3)
  })
})

describe('hasInk', () => {
  it('finds nothing in a flat box: text that never painted', () => {
    expect(hasInk(flat(20, 20), { x: 2, y: 2, width: 10, height: 10 })).toBe(false)
  })

  it('finds a glyph in the box', () => {
    const bitmap = flat(20, 20)
    paint(bitmap, 6, 6, [0xf0, 0xe8, 0xe6, 0xff])
    expect(hasInk(bitmap, { x: 2, y: 2, width: 10, height: 10 })).toBe(true)
  })

  it('finds dim text on a card: a contrast on any one channel counts', () => {
    const bitmap = flat(20, 20, [0x1c, 0x15, 0x14, 0xff])
    paint(bitmap, 6, 6, [0x1c + MIN_INK_CONTRAST, 0x15, 0x14, 0xff])
    expect(hasInk(bitmap, { x: 2, y: 2, width: 10, height: 10 })).toBe(true)
  })

  it('ignores a shade just under the contrast: a gradient, not a glyph', () => {
    const bitmap = flat(20, 20)
    paint(bitmap, 6, 6, [0x0f + MIN_INK_CONTRAST - 1, 0x0b, 0x0a, 0xff])
    expect(hasInk(bitmap, { x: 2, y: 2, width: 10, height: 10 })).toBe(false)
  })

  it('ignores the alpha channel', () => {
    const bitmap = flat(20, 20)
    paint(bitmap, 6, 6, [0x0f, 0x0b, 0x0a, 0x00])
    expect(hasInk(bitmap, { x: 2, y: 2, width: 10, height: 10 })).toBe(false)
  })

  it('only looks inside the box', () => {
    const bitmap = flat(20, 20)
    paint(bitmap, 15, 15, [0xff, 0xff, 0xff, 0xff])
    expect(hasInk(bitmap, { x: 2, y: 2, width: 10, height: 10 })).toBe(false)
  })

  it('covers the pixels a fractional box partly covers, and no more', () => {
    const box = { x: 2.5, y: 2.5, width: 8.2, height: 8.2 }
    for (const [at, inside] of [
      [2, true],
      [10, true],
      [1, false],
      [11, false],
    ] as const) {
      const bitmap = flat(20, 20)
      paint(bitmap, at, at, [0xff, 0xff, 0xff, 0xff])
      expect(hasInk(bitmap, box)).toBe(inside)
    }
  })

  it('clips a box that runs off the bitmap', () => {
    const bitmap = flat(20, 20)
    paint(bitmap, 19, 19, [0xff, 0xff, 0xff, 0xff])
    expect(hasInk(bitmap, { x: 15, y: 15, width: 50, height: 50 })).toBe(true)
    expect(hasInk(bitmap, { x: -5, y: -5, width: 10, height: 10 })).toBe(false)
  })

  it('finds nothing in a box wholly off the bitmap', () => {
    expect(hasInk(flat(20, 20), { x: 40, y: 40, width: 10, height: 10 })).toBe(false)
  })

  it('treats pixels a short buffer lacks as black', () => {
    const bitmap: Bitmap = { width: 4, height: 4, data: new Uint8Array(4 * 4).fill(0xff) }
    expect(hasInk(bitmap, { x: 0, y: 0, width: 4, height: 4 })).toBe(true)
  })

  it('takes a custom contrast', () => {
    const bitmap = flat(20, 20)
    paint(bitmap, 6, 6, [0x0f + 10, 0x0b, 0x0a, 0xff])
    expect(hasInk(bitmap, { x: 2, y: 2, width: 10, height: 10 }, 10)).toBe(true)
    expect(hasInk(bitmap, { x: 2, y: 2, width: 10, height: 10 }, 11)).toBe(false)
  })
})

describe('inkedShare', () => {
  it('is 0 with no boxes: there is no text to see', () => {
    expect(inkedShare(flat(10, 10), [])).toBe(0)
  })

  it('is the share of boxes that show ink', () => {
    const bitmap = flat(100, 10)
    write(bitmap, BOXES.slice(0, 7))
    expect(inkedShare(bitmap, BOXES)).toBeCloseTo(0.7)
  })
})

describe('captureProblems', () => {
  it('passes a capture with all its text', () => {
    const bitmap = flat(100, 10)
    write(bitmap, BOXES)
    expect(captureProblems(bitmap, BOXES, 100, 10)).toEqual([])
  })

  it('passes a capture where some text is covered, like under a menu', () => {
    const bitmap = flat(100, 10)
    write(bitmap, BOXES.slice(0, 8))
    expect(captureProblems(bitmap, BOXES, 100, 10)).toEqual([])
  })

  it('fails a capture taken before the text painted: the bug', () => {
    expect(captureProblems(flat(100, 10), BOXES, 100, 10)).toEqual([
      'only 0% of its 10 text boxes show text (needs 80%)',
    ])
  })

  it('fails a capture with only some of its text', () => {
    const bitmap = flat(100, 10)
    write(bitmap, BOXES.slice(0, 7))
    expect(captureProblems(bitmap, BOXES, 100, 10)).toEqual(['only 70% of its 10 text boxes show text (needs 80%)'])
  })

  it('fails a page with no text boxes', () => {
    expect(captureProblems(flat(100, 10), [], 100, 10)).toEqual(['only 0% of its 0 text boxes show text (needs 80%)'])
  })

  it('fails an image of the wrong size, like an unscaled 2x capture or a stale PNG', () => {
    const bitmap = flat(200, 20)
    write(bitmap, BOXES)
    expect(captureProblems(bitmap, BOXES, 100, 10)).toEqual(['the image is 200×20, not 100×10'])
  })
})

describe('captureWithRetries', () => {
  /** Returns at once instead of waiting; a wait is never negative. */
  const noSleep = (ms: number): Promise<void> => {
    expect(ms).toBeGreaterThanOrEqual(0)
    return Promise.resolve()
  }

  it('returns the first attempt that passes, without waiting', async () => {
    const sleep = vi.fn(noSleep)
    const run = vi.fn((): Promise<AttemptResult<string>> => Promise.resolve({ ok: true, value: 'png' }))
    await expect(captureWithRetries({ label: 's.html', attempts: 3, run, delayMs: backoffMs, sleep })).resolves.toBe(
      'png',
    )
    expect(run).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries a capture without its text until one has it, waiting longer each time', async () => {
    const results: AttemptResult<string>[] = [
      { ok: false, problems: ['only 1% of its 159 text boxes show text (needs 80%)'] },
      { ok: false, problems: ['fonts are still loading'] },
      { ok: true, value: 'png' },
    ]
    const run = vi.fn((attempt: number): Promise<AttemptResult<string>> =>
      Promise.resolve(results[attempt - 1] ?? { ok: false, problems: ['ran out of results'] }),
    )
    const sleep = vi.fn(noSleep)
    const onRetry = vi.fn()
    await expect(
      captureWithRetries({ label: 's.html', attempts: 5, run, delayMs: backoffMs, sleep, onRetry }),
    ).resolves.toBe('png')
    expect(run.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2, 3])
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500])
    expect(onRetry.mock.calls).toEqual([
      [1, ['only 1% of its 159 text boxes show text (needs 80%)']],
      [2, ['fonts are still loading']],
    ])
  })

  it('fails loudly when no attempt passes, listing each one', async () => {
    const run = vi.fn((attempt: number): Promise<AttemptResult<string>> =>
      Promise.resolve({ ok: false, problems: [`problem ${String(attempt)}`, 'another'] }),
    )
    const onRetry = vi.fn()
    const capture = captureWithRetries({ label: 's.html', attempts: 3, run, delayMs: () => 0, sleep: noSleep, onRetry })
    await expect(capture).rejects.toThrow(CaptureError)
    await expect(capture).rejects.toThrow(
      's.html never rendered with its text after 3 attempts:\n' +
        '  attempt 1: problem 1; another\n' +
        '  attempt 2: problem 2; another\n' +
        '  attempt 3: problem 3; another',
    )
    const error: unknown = await capture.catch((reason: unknown) => reason)
    expect(error).toMatchObject({
      name: 'CaptureError',
      label: 's.html',
      failures: [
        ['problem 1', 'another'],
        ['problem 2', 'another'],
        ['problem 3', 'another'],
      ],
    })
    expect(run).toHaveBeenCalledTimes(3)
    // The last failure isn't retried, so it isn't reported as a retry.
    expect(onRetry).toHaveBeenCalledTimes(2)
  })

  it('runs without an onRetry', async () => {
    const run = vi.fn((attempt: number): Promise<AttemptResult<number>> =>
      Promise.resolve(attempt < 2 ? { ok: false, problems: ['no text'] } : { ok: true, value: attempt }),
    )
    await expect(captureWithRetries({ label: 's', attempts: 2, run, delayMs: () => 0, sleep: noSleep })).resolves.toBe(
      2,
    )
  })

  it('lets an error from a capture through', async () => {
    const run = (): Promise<AttemptResult<string>> => Promise.reject(new Error('the window crashed'))
    await expect(
      captureWithRetries({ label: 's', attempts: 3, run, delayMs: () => 0, sleep: noSleep }),
    ).rejects.toThrow('the window crashed')
  })

  it('refuses fewer than one attempt', async () => {
    const run = vi.fn()
    await expect(
      captureWithRetries({ label: 's', attempts: 0, run, delayMs: () => 0, sleep: noSleep }),
    ).rejects.toThrow(RangeError)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('backoffMs', () => {
  it('doubles from 250ms', () => {
    expect([2, 3, 4, 5, 6].map(backoffMs)).toEqual([250, 500, 1000, 2000, 4000])
  })
})
