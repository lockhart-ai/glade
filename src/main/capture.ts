/**
 * Capture mode, behind `npm run screenshot`: the app runs with a throwaway data folder, renders into a window that is
 * never shown, captures the page at each requested size with `capturePage()`, writes the PNGs and exits. It never
 * runs in a packaged app.
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { z } from 'zod'
import { READY_ATTRIBUTE } from '../shared/ready'

/** The environment variable that carries the capture spec, as JSON. */
export const CAPTURE_ENV = 'GLADE_CAPTURE'

/** One PNG to capture: the window's content size, and the file name to write it to in the spec's `outDir`. */
export interface CaptureShot {
  readonly width: number
  readonly height: number
  readonly file: string
}

/** What to capture, handed to the app by `scripts/screenshot.mjs`. */
export interface CaptureSpec {
  /** The folder the PNGs go in. */
  readonly outDir: string
  /**
   * The app's data folder for the run: an empty folder in the system temp folder, made (and removed afterwards) by the
   * caller, so the real database is never touched and nothing is left behind.
   */
  readonly userData: string
  /** The page's location hash, e.g. `#gallery`, or `''` for the app itself. */
  readonly route: string
  readonly shots: readonly CaptureShot[]
  /** How long the whole capture may take before it gives up. */
  readonly timeoutMs: number
  /** A JSON fixture of sample data (see `./capture-seed`) to fill the throwaway database with; none for a fresh app. */
  readonly seed?: string | undefined
}

/** The largest window side, in pixels, a capture may ask for. */
const MAX_SIDE = 8192

/** The smallest content size the window allows. */
export interface MinimumSize {
  readonly width: number
  readonly height: number
}

function captureSpecSchema(minimum: MinimumSize): z.ZodType<CaptureSpec> {
  return z.strictObject({
    outDir: z.string().refine(isAbsolute, 'must be an absolute path'),
    userData: z.string().refine(isInTempFolder, `must be a folder in ${tmpdir()}`),
    route: z.string().regex(/^(#[\w\-/]*)?$/, 'must be empty or a hash like #gallery'),
    shots: z
      .array(
        z.strictObject({
          width: z.int().min(minimum.width).max(MAX_SIDE),
          height: z.int().min(minimum.height).max(MAX_SIDE),
          file: z.string().regex(/^[\w.-]+\.png$/, 'must be a plain .png file name'),
        }),
      )
      .min(1),
    timeoutMs: z.int().positive(),
    seed: z.string().refine(isAbsolute, 'must be an absolute path').optional(),
  })
}

/** Whether `path` is an absolute path inside (not at) the system temp folder. */
function isInTempFolder(path: string): boolean {
  const inside = relative(tmpdir(), path)
  return isAbsolute(path) && inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)
}

/** The capture spec was set but isn't valid. */
export class CaptureSpecError extends Error {}

/**
 * The capture spec in `env`, or `null` when the app should run normally: when the variable isn't set, or when the app
 * is packaged, where capture mode can never run. Throws a `CaptureSpecError` when the spec is set but invalid,
 * including when a shot is smaller than the window's `minimum` size.
 */
export function readCaptureSpec(env: NodeJS.ProcessEnv, isPackaged: boolean, minimum: MinimumSize): CaptureSpec | null {
  const raw = env[CAPTURE_ENV]
  if (isPackaged || raw === undefined) return null

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    throw new CaptureSpecError(`${CAPTURE_ENV} is not JSON: ${(error as Error).message}`)
  }
  const parsed = captureSpecSchema(minimum).safeParse(json)
  if (!parsed.success) throw new CaptureSpecError(`${CAPTURE_ENV} is invalid: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

/** The parts of Electron's `app` that capture mode sets up before the app is ready. */
export interface CaptureApp {
  setPath(name: 'userData', path: string): void
  readonly dock?: { hide(): void } | undefined
}

/**
 * Sets the app up for a capture. Call before the app is ready. Points the data folder at the spec's fresh temporary
 * folder, so the real database is never touched, and hides the dock icon, so the app never appears or takes focus.
 * Throws a `CaptureSpecError` unless that folder exists and is empty.
 */
export function prepareCapture(app: CaptureApp, spec: CaptureSpec): void {
  let entries: string[]
  try {
    entries = readdirSync(spec.userData)
  } catch (error) {
    throw new CaptureSpecError(`the capture data folder can't be read: ${(error as Error).message}`)
  }
  if (entries.length > 0) throw new CaptureSpecError(`the capture data folder ${spec.userData} is not empty`)
  app.setPath('userData', spec.userData)
  app.dock?.hide()
}

/** The parts of a `BrowserWindow` a capture drives. The window is never shown. */
export interface CaptureWindow {
  setContentSize(width: number, height: number): void
  readonly webContents: {
    executeJavaScript(code: string): Promise<unknown>
    capturePage(): Promise<CaptureImage>
  }
}

/** The parts of a `NativeImage` a capture uses. */
export interface CaptureImage {
  getSize(): { width: number; height: number }
  resize(options: { width: number; height: number; quality: 'best' }): CaptureImage
  toPNG(): Buffer
}

/** Waits (in the page) until the renderer has marked itself ready. */
const WAIT_UNTIL_READY = `new Promise((resolve) => {
  const check = () => document.documentElement.hasAttribute(${JSON.stringify(READY_ATTRIBUTE)}) ? resolve(true) : setTimeout(check, 20)
  check()
})`

/** Waits (in the page) until the viewport has the given size and the page has laid out and painted at it. */
function waitForSize(width: number, height: number): string {
  return `new Promise((resolve) => {
  const check = () => window.innerWidth === ${String(width)} && window.innerHeight === ${String(height)}
    ? requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))
    : setTimeout(check, 20)
  check()
})`
}

/**
 * Captures each shot in `spec`: waits for the renderer to say it's ready, then for each shot resizes the window,
 * waits for the page to lay out at that size, and writes a PNG of it at exactly that size (a Retina display captures
 * at 2x, which is scaled down, so the PNGs match the 1x design screens). Returns the files written.
 */
export async function captureShots(window: CaptureWindow, spec: CaptureSpec): Promise<string[]> {
  await window.webContents.executeJavaScript(WAIT_UNTIL_READY)
  mkdirSync(spec.outDir, { recursive: true })

  const files: string[] = []
  for (const { width, height, file } of spec.shots) {
    window.setContentSize(width, height)
    await window.webContents.executeJavaScript(waitForSize(width, height))
    const captured = await window.webContents.capturePage()
    const size = captured.getSize()
    const image =
      size.width === width && size.height === height ? captured : captured.resize({ width, height, quality: 'best' })
    const path = join(spec.outDir, file)
    writeFileSync(path, image.toPNG())
    files.push(path)
  }
  return files
}

/** Rejects after `ms` milliseconds, unless `work` settles first. */
export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Capture timed out after ${String(ms)} ms`))
    }, ms)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}
