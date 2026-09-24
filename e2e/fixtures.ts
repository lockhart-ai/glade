/**
 * The fixtures every e2e spec uses: `launch` starts the built app in e2e mode and waits until it's ready, and
 * `tempFolder` makes a throwaway folder, e.g. to open as a workspace. Specs import `test` and `expect` from here.
 *
 * The app never touches real data: each test gets a fresh data folder in the system temp folder, removed afterwards.
 * Its window is never shown; Playwright drives it (and records it, under `npm run record`) over the DevTools protocol.
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { _electron as electron, test as base, type ElectronApplication, type Page } from '@playwright/test'
import { E2E_CHOSEN_FOLDER_ENV, E2E_ENV, E2E_WINDOW_SIZE, type E2eSpec } from '../src/main/e2e'
import { READY_ATTRIBUTE } from '../src/shared/ready'

export { expect } from '@playwright/test'

/** The built main script, from scripts/test-build.mjs. */
const MAIN = resolve(__dirname, '..', 'out', 'testing', 'main', 'index.js')

/**
 * Where `npm run record` wants the videos: set by scripts/e2e.mjs. Each launch writes `<spec>--<test>.webm` there
 * (with `-2`, `-3`… for a test's later launches); the script converts them to MP4 and GIF afterwards.
 */
const RECORD_DIR = process.env.GLADE_RECORD_DIR

/** How to launch the app. */
export interface LaunchOptions {
  /** The page's location hash, e.g. `#gallery`. The app itself by default. */
  readonly route?: string
  /** What the folder dialog answers with, until `chooseFolder` changes it. Cancelled by default. */
  readonly chosenFolder?: string
}

/** A running app: its main process, and its window's page. */
export interface Glade {
  readonly app: ElectronApplication
  readonly window: Page
  /** Quits the app, e.g. to launch it again on the same data. The fixture closes any app a test leaves running. */
  close(): Promise<void>
}

/**
 * How long a recording holds on the final state before the app closes. A hidden window sends the screencast frames as
 * it paints, and the last ones would otherwise be cut off. It only affects recordings, never what a test checks.
 */
const RECORDING_HOLD_MS = 1000

interface Fixtures {
  /**
   * Launches the app and waits until its page is ready (rendered, fonts loaded, store hydrated). Every launch in a
   * test shares the test's data folder, so a spec can close the app and launch it again to check what it restores.
   */
  launch: (options?: LaunchOptions) => Promise<Glade>
  /** Makes an empty folder in the system temp folder, removed after the test. */
  tempFolder: (prefix?: string) => string
}

/** Environment for the app: the e2e spec, and nothing that would make it run as Node or load a dev server. */
function appEnv(spec: E2eSpec, chosenFolder: string | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE' && key !== 'ELECTRON_RENDERER_URL') env[key] = value
  }
  env[E2E_ENV] = JSON.stringify(spec)
  if (chosenFolder !== undefined) env[E2E_CHOSEN_FOLDER_ENV] = chosenFolder
  return env
}

/** A file-name-safe slug of a spec's file and title, for its recording. */
function videoName(file: string, title: string): string {
  const slug = (text: string): string =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
  return `${slug(basename(file, '.spec.ts'))}--${slug(title)}`
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright reads what a fixture depends on from this pattern.
  tempFolder: async ({}, use) => {
    const folders: string[] = []
    await use((prefix = 'glade-e2e-folder-') => {
      const folder = mkdtempSync(join(tmpdir(), prefix))
      folders.push(folder)
      return folder
    })
    for (const folder of folders) rmSync(folder, { recursive: true, force: true })
  },

  launch: async ({ tempFolder }, use, testInfo) => {
    const userData = tempFolder('glade-e2e-data-')
    const launched: Glade[] = []
    const name = videoName(testInfo.file, testInfo.title)

    /** Closes a launched app and, when recording, keeps its video as `<name>.webm` (`<name>-2.webm` for the 2nd…). */
    async function closeApp({ app, window }: Glade, index: number): Promise<void> {
      const video = window.video()
      if (video !== null) await window.waitForTimeout(RECORDING_HOLD_MS)
      await app.close()
      if (RECORD_DIR !== undefined && video !== null) {
        mkdirSync(RECORD_DIR, { recursive: true })
        const suffix = index === 0 ? '' : `-${String(index + 1)}`
        renameSync(await video.path(), join(RECORD_DIR, `${name}${suffix}.webm`))
      }
    }

    await use(async ({ route = '', chosenFolder } = {}) => {
      const app = await electron.launch({
        args: [MAIN],
        env: appEnv({ userData, route }, chosenFolder),
        ...(RECORD_DIR === undefined
          ? {}
          : { recordVideo: { dir: testInfo.outputPath('video'), size: E2E_WINDOW_SIZE, showActions: {} } }),
      })
      const window = await app.firstWindow()
      const index = launched.length
      let closing: Promise<void> | undefined
      const glade: Glade = {
        app,
        window,
        close: () => (closing ??= closeApp(glade, index)),
      }
      launched.push(glade)
      await window.locator(`html[${READY_ATTRIBUTE}]`).waitFor({ state: 'attached' })
      return glade
    })

    for (const glade of launched) await glade.close()
  },
})

/**
 * Sets what the folder dialog answers with the next time it opens (and after), since a test can't click a native
 * dialog: a folder's path, or `null` for "cancelled".
 */
export async function chooseFolder({ app }: Glade, path: string | null): Promise<void> {
  await app.evaluate(
    (_, { name, value }) => {
      if (value === null) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    },
    { name: E2E_CHOSEN_FOLDER_ENV, value: path },
  )
}
