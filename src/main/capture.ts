/**
 * Capture mode, behind `npm run screenshot`: the app runs with a throwaway data folder, renders into a window that is
 * never shown, captures the page at each requested size with `capturePage()`, writes the PNGs and exits. It never
 * runs in a packaged app.
 */
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { PLUGINS_FOLDER_NAME } from '../shared/plugins'
import { READY_ATTRIBUTE } from '../shared/ready'
import { AGENT_SCRIPT_NAMES, type AgentScriptName } from './agent/scripts'
import {
  CAPTURE_POLL_MS,
  composeViews,
  delay,
  parseSlots,
  SLOTS_SCRIPT,
  viewsSettled,
  type Bitmap,
  type CaptureView,
} from './capture-views'
import { isInTempFolder, isolateApp, type IsolatedApp } from './isolation'

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
  /**
   * A conversation to seed before capturing, so the capture shows a populated task: a first message, answered by the
   * named agent script (see `src/main/agent/scripts.ts`). None by default.
   */
  readonly conversation?: CaptureConversation
  /** A JSON fixture of sample data (see `./capture-seed`) to fill the throwaway database with; none for a fresh app. */
  readonly seed?: string | undefined
  /**
   * Keys to press in the page, in order, once it's ready and before capturing, e.g. ⌘, to capture the Settings modal.
   * None by default.
   */
  readonly presses?: readonly CaptureKeyPress[] | undefined
  /**
   * Elements to click in the page, by CSS selector, in order, after the key presses and before capturing, e.g. a
   * Settings section's nav button. Each waits until nothing on the page is busy (`aria-busy="true"`). None by default.
   */
  readonly clicks?: readonly string[] | undefined
  /**
   * Folders of sample plugins (see `scripts/fixtures/plugins/`) whose plugins are copied into the data folder's plugins
   * folder before the app starts, so the capture shows them. None by default.
   */
  readonly plugins?: readonly string[] | undefined
}

/** One key press, as a `keydown` on the page's window: its `key` and modifiers. */
export interface CaptureKeyPress {
  readonly key: string
  readonly metaKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly ctrlKey: boolean
}

export interface CaptureConversation {
  readonly agentScript: AgentScriptName
  /** The user's first message. */
  readonly message: string
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
    conversation: z
      .strictObject({ agentScript: z.enum(AGENT_SCRIPT_NAMES), message: z.string().trim().min(1) })
      .optional(),
    seed: z.string().refine(isAbsolute, 'must be an absolute path').optional(),
    presses: z
      .array(
        z.strictObject({
          key: z.string().min(1),
          metaKey: z.boolean(),
          shiftKey: z.boolean(),
          altKey: z.boolean(),
          ctrlKey: z.boolean(),
        }),
      )
      .optional(),
    clicks: z.array(z.string().min(1)).optional(),
    plugins: z.array(z.string().refine(isAbsolute, 'must be an absolute path')).optional(),
  })
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
export type CaptureApp = IsolatedApp

/**
 * Sets the app up for a capture. Call before the app is ready. Points the data folder at the spec's fresh temporary
 * folder, so the real database is never touched, and hides the dock icon, so the app never appears or takes focus.
 * Throws a `CaptureSpecError` unless that folder exists and is empty.
 */
export function prepareCapture(app: CaptureApp, spec: CaptureSpec): void {
  try {
    isolateApp(app, { mode: 'capture', userData: spec.userData, reuse: false })
  } catch (error) {
    throw new CaptureSpecError((error as Error).message)
  }
  for (const plugins of spec.plugins ?? []) {
    cpSync(plugins, join(spec.userData, PLUGINS_FOLDER_NAME), { recursive: true, verbatimSymlinks: true })
  }
}

/** The parts of a `BrowserWindow` a capture drives. The window is never shown. */
export interface CaptureWindow {
  setContentSize(width: number, height: number): void
  readonly webContents: {
    executeJavaScript(code: string): Promise<unknown>
    capturePage(): Promise<CaptureImage>
  }
  /** The native views over the page, such as a plugin's, which its capture leaves out; none by default. */
  nativeViews?(): readonly CaptureView[]
}

/** The parts of a `NativeImage` a capture uses. */
export interface CaptureImage {
  getSize(): { width: number; height: number }
  resize(options: { width: number; height: number; quality: 'best' }): CaptureImage
  toPNG(): Buffer
  toBitmap(): Buffer
}

/** Makes an image from raw BGRA pixels (Electron's `nativeImage.createFromBitmap`), to paste native views into. */
export type ImageFromBitmap = (bitmap: Bitmap) => CaptureImage

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

/** Presses a key (in the page) where the app listens for its shortcuts, then waits for it to paint what it did. */
function pressKey(press: CaptureKeyPress): string {
  return `new Promise((resolve) => {
  window.dispatchEvent(new KeyboardEvent('keydown', { ...${JSON.stringify(press)}, bubbles: true, cancelable: true }))
  requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))
})`
}

/** How long a click waits for its element to show up. */
const CLICK_WAIT_MS = 5000

/** How long a capture waits for the page's native views to settle over their slots. */
const VIEW_WAIT_MS = 10_000

/**
 * The native views over the page, once each showing slot in the page has one over it and each has painted; none when
 * the window has none to show.
 */
async function settledViews(window: CaptureWindow): Promise<readonly CaptureView[]> {
  if (window.nativeViews === undefined) return []
  const giveUp = Date.now() + VIEW_WAIT_MS
  for (;;) {
    const slots = parseSlots(await window.webContents.executeJavaScript(SLOTS_SCRIPT))
    const views = window.nativeViews()
    if (viewsSettled(slots, views)) {
      for (const view of views) if (view.visible) await view.settle()
      return views
    }
    if (Date.now() > giveUp) throw new Error("The page's native views didn't settle over their slots")
    await delay(CAPTURE_POLL_MS)
  }
}

/**
 * Clicks an element (in the page) once it shows up, then waits until nothing on the page is busy, its animations have
 * finished and it has painted.
 * Rejects when nothing matches the selector in time.
 */
function clickElement(selector: string): string {
  return `new Promise((resolve, reject) => {
  const selector = ${JSON.stringify(selector)}
  const giveUp = Date.now() + ${String(CLICK_WAIT_MS)}
  const painted = () => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))
  // Once nothing is busy, the transitions the click started (a toggle sliding over) finish before the capture.
  const settle = () => document.querySelector('[aria-busy="true"]') === null
    ? Promise.all(document.getAnimations().map((animation) => animation.finished)).then(painted, painted)
    : setTimeout(settle, 20)
  const click = () => {
    const element = document.querySelector(selector)
    if (element instanceof HTMLElement) {
      element.click()
      requestAnimationFrame(settle)
    } else if (Date.now() > giveUp) {
      reject(new Error('Nothing to click at ' + selector))
    } else {
      setTimeout(click, 20)
    }
  }
  click()
})`
}

/**
 * Captures each shot in `spec`: waits for the renderer to say it's ready, presses the spec's keys and clicks its
 * elements, then for each shot
 * resizes the window,
 * waits for the page to lay out at that size (and any native view, such as a plugin's, to settle over its slot, to be
 * pasted in with `fromBitmap`), and writes a PNG of it at exactly that size (a Retina display captures at 2x, which is
 * scaled down, so the PNGs match the 1x design screens). Returns the files written.
 */
export async function captureShots(
  window: CaptureWindow,
  spec: CaptureSpec,
  fromBitmap?: ImageFromBitmap,
): Promise<string[]> {
  await window.webContents.executeJavaScript(WAIT_UNTIL_READY)
  for (const press of spec.presses ?? []) await window.webContents.executeJavaScript(pressKey(press))
  for (const selector of spec.clicks ?? []) await window.webContents.executeJavaScript(clickElement(selector))
  mkdirSync(spec.outDir, { recursive: true })

  const files: string[] = []
  for (const { width, height, file } of spec.shots) {
    window.setContentSize(width, height)
    await window.webContents.executeJavaScript(waitForSize(width, height))
    const views = await settledViews(window)
    // With a plugin's view (or any other native view) over the page, it's pasted into the page's capture.
    const page = await window.webContents.capturePage()
    const captured =
      fromBitmap === undefined || views.every(({ visible }) => !visible)
        ? page
        : fromBitmap(await composeViews(page, width, views))
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
