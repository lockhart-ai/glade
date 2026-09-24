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
import type { AgentScriptName } from '../src/main/agent/scripts'
import {
  E2E_CHOSEN_FOLDER_ENV,
  E2E_DESKTOP_GLOBAL,
  E2E_EDITOR_GLOBAL,
  E2E_ENV,
  E2E_NETWORK_GLOBAL,
  E2E_NOTIFIER_GLOBAL,
  E2E_WINDOW_SIZE,
  type E2eDesktop,
  type E2eEditor,
  type E2eNetwork,
  type E2eSpec,
} from '../src/main/e2e'
import type { TaskNotification } from '../src/main/notifications/notifier'
import type { RecordingNotifier } from '../src/main/notifications/recording-notifier'
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
  /**
   * The agent script every task's agent plays (see `src/main/agent/scripts.ts`). None by default, and then sending a
   * task a message fails: no e2e run ever reaches the real agent.
   */
  readonly agentScript?: AgentScriptName
  /**
   * The agent scripts to play in place of `agentScript` for the tasks whose first message is exactly the key, e.g. to
   * run `long-running` in one task and `multi-tool-turn` in another at once.
   */
  readonly agentScriptsByFirstMessage?: Readonly<Record<string, AgentScriptName>>
  /**
   * A sample-data fixture (a JSON file in `e2e/seeds/`, see `src/main/capture-seed.ts`) to fill the database with
   * before the window opens. Pass it on a test's first launch only.
   */
  readonly seed?: string
}

/** The path of a sample-data fixture in `e2e/seeds/`, by file name. */
export function seedPath(name: string): string {
  return resolve(__dirname, 'seeds', name)
}

/** A running app: its main process, and its window's page. */
export interface Glade {
  readonly app: ElectronApplication
  readonly window: Page
  /** Quits the app, e.g. to launch it again on the same data. The fixture closes any app a test leaves running. */
  close(): Promise<void>
  /** Kills the app's process outright, as a force-quit or crash would: nothing gets to run on the way out. */
  kill(): Promise<void>
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

    /**
     * Closes a launched app, or kills it as a force-quit or crash would, and, when recording, keeps its video as
     * `<name>.webm` (`<name>-2.webm` for the 2nd…).
     */
    async function closeApp({ app, window }: Glade, index: number, kill: boolean): Promise<void> {
      const video = window.video()
      if (video !== null) await window.waitForTimeout(RECORDING_HOLD_MS)
      if (kill) {
        const exited = app.waitForEvent('close')
        app.process().kill('SIGKILL')
        await exited
      } else {
        await app.close()
      }
      if (RECORD_DIR !== undefined && video !== null) {
        mkdirSync(RECORD_DIR, { recursive: true })
        const suffix = index === 0 ? '' : `-${String(index + 1)}`
        renameSync(await video.path(), join(RECORD_DIR, `${name}${suffix}.webm`))
      }
    }

    await use(async ({ route = '', chosenFolder, agentScript, agentScriptsByFirstMessage, seed } = {}) => {
      const spec: E2eSpec = {
        userData,
        route,
        ...(agentScript === undefined ? {} : { agentScript }),
        ...(agentScriptsByFirstMessage === undefined ? {} : { agentScriptsByFirstMessage }),
        ...(seed === undefined ? {} : { seed }),
      }
      const app = await electron.launch({
        args: [MAIN],
        env: appEnv(spec, chosenFolder),
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
        close: () => (closing ??= closeApp(glade, index, false)),
        kill: () => (closing ??= closeApp(glade, index, true)),
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

/**
 * The notifications the app has shown so far, oldest first. An e2e run never shows a real one: main records them in
 * its place (`E2E_NOTIFIER_GLOBAL`).
 */
export async function notifications({ app }: Glade): Promise<TaskNotification[]> {
  return app.evaluate((_, name) => [...(Reflect.get(globalThis, name) as RecordingNotifier).shown], E2E_NOTIFIER_GLOBAL)
}

/** Clicks the `index`th notification the app has shown, as the OS would when you click it. */
export async function clickNotification({ app }: Glade, index: number): Promise<void> {
  await app.evaluate(
    (_, { name, index }) => {
      ;(Reflect.get(globalThis, name) as RecordingNotifier).click(index)
    },
    { name: E2E_NOTIFIER_GLOBAL, index },
  )
}

/** Sends `text` from the `index`th notification's inline reply, as the OS would when you reply to it. */
export async function replyToNotification({ app }: Glade, index: number, text: string): Promise<void> {
  await app.evaluate(
    (_, { name, index, text }) => {
      ;(Reflect.get(globalThis, name) as RecordingNotifier).reply(index, text)
    },
    { name: E2E_NOTIFIER_GLOBAL, index, text },
  )
}

/**
 * The files Open in editor opened so far, oldest first, by their real paths. An e2e run never opens a real editor: main
 * records them in its place (`E2E_EDITOR_GLOBAL`).
 */
export async function openedInEditor({ app }: Glade): Promise<string[]> {
  return app.evaluate((_, name) => [...(Reflect.get(globalThis, name) as E2eEditor).opened], E2E_EDITOR_GLOBAL)
}

/**
 * What the context menus have copied to the clipboard and shown in Finder so far, oldest first. An e2e run never
 * touches the real clipboard or Finder: main records them in its place (`E2E_DESKTOP_GLOBAL`).
 */
export async function desktop({ app }: Glade): Promise<E2eDesktop> {
  return app.evaluate((_, name) => {
    const { copied, revealed } = Reflect.get(globalThis, name) as E2eDesktop
    return { copied: [...copied], revealed: [...revealed] }
  }, E2E_DESKTOP_GLOBAL)
}

/**
 * Takes the app offline, or brings it back online, as far as its check for the network is concerned
 * (`E2E_NETWORK_GLOBAL`): an e2e run can't unplug the machine. The app starts online.
 */
export async function setOnline({ app }: Glade, online: boolean): Promise<void> {
  await app.evaluate(
    (_, { name, value }) => {
      ;(Reflect.get(globalThis, name) as E2eNetwork).online = value
    },
    { name: E2E_NETWORK_GLOBAL, value: online },
  )
}
