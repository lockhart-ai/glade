/**
 * The fixtures every e2e spec uses: `launch` starts the built app in e2e mode and waits until it's ready, and
 * `tempFolder` makes a throwaway folder, e.g. to open as a workspace. Specs import `test` and `expect` from here.
 *
 * The app never touches real data: each test gets a fresh data folder in the system temp folder, removed afterwards.
 * Its window is never shown; Playwright drives it (and records it, under `npm run record`) over the DevTools protocol.
 */
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { _electron as electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test'
import type { AgentScriptName } from '../src/main/agent/scripts'
import {
  E2E_AGENT_GLOBAL,
  E2E_AGENT_ENVS_GLOBAL,
  E2E_CHOSEN_FOLDER_ENV,
  E2E_DESKTOP_GLOBAL,
  E2E_EDITOR_GLOBAL,
  E2E_ENV,
  E2E_NETWORK_GLOBAL,
  E2E_NOTIFIER_GLOBAL,
  E2E_WINDOW_SIZE,
  type E2eAgent,
  type E2eAgentEnvs,
  type E2eDesktop,
  type E2eEditor,
  type E2eNetwork,
  type E2eSpec,
} from '../src/main/e2e'
import { testModeLogsFolder } from '../src/main/isolation'
import { LOG_FILE_NAME } from '../src/main/logging/file-sink'
import type { TaskNotification } from '../src/main/notifications/notifier'
import type { RecordingNotifier } from '../src/main/notifications/recording-notifier'
import { COMMAND_CHANNEL, type CommandName } from '../src/shared/bridge'
import { PLUGINS_FOLDER_NAME } from '../src/shared/plugins'
import { READY_ATTRIBUTE } from '../src/shared/ready'
import { firstRun, taskList } from './selectors'

export { expect } from '@playwright/test'

/** The built main script, from scripts/test-build.mjs. */
const MAIN = resolve(__dirname, '..', 'out', 'testing', 'main', 'index.js')

/**
 * Where `npm run record` wants the videos: set by scripts/e2e.mjs. Each launch writes `<spec>--<test>.webm` there
 * (with `-2`, `-3`… for a test's later launches); the script converts them to MP4 and GIF afterwards.
 */
const RECORD_DIR = process.env.GLADE_RECORD_DIR

/**
 * The hour of the day the app's clock reads during a test. Seeds and specs work in minutes before now, and a date
 * label ("Sep 25, 00:03") shows up wherever those times straddle midnight; midday keeps them hours from it.
 */
const LOCAL_HOUR = 12

/**
 * A time zone in which it's now `hour` o'clock: a fixed-offset `Etc/GMT` zone (whole hours, no daylight saving; its
 * sign is inverted, so `Etc/GMT-5` is UTC+5). The app runs in it, so its clock reads that hour whatever the host's.
 */
export function timeZoneAtHour(hour: number, now: Date = new Date()): string {
  const ahead = (hour - now.getUTCHours() + 24) % 24
  // The zones run from UTC-12 to UTC+14.
  const offset = ahead > 14 ? ahead - 24 : ahead
  if (offset === 0) return 'Etc/GMT'
  return `Etc/GMT${offset > 0 ? '-' : '+'}${String(Math.abs(offset))}`
}

/** macOS's legacy, always-on scroll bars, as a user default on the command line (its argument domain). */
const CLASSIC_SCROLLBAR_ARGS = ['-AppleShowScrollBars', 'Always'] as const

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
  /**
   * A login shell for the app to read its agents' environment from (a script standing in for `$SHELL` and its
   * profile). None by default: the agents run in the app's own environment.
   */
  readonly loginShell?: string
  /** Environment variables to launch the app with, over the test runner's own, e.g. launchd's bare `PATH`. */
  readonly env?: Readonly<Record<string, string>>
  /**
   * Whether the app animates (docs/design/tokens.md, Motion). Off by default: the window runs as with macOS's Reduce
   * motion on, so every change lands at once and no test waits on an animation. Specs of the animations turn it on.
   */
  readonly motion?: boolean
  /**
   * Whether macOS draws its legacy scroll bars, which always show and take room, as with System Settings' "Show scroll
   * bars: Always" or a mouse attached. Off by default: the system's setting, overlay scroll bars on a Mac with a
   * trackpad. The app gets `-AppleShowScrollBars Always` on its command line, which macOS reads as that user default
   * for this run only.
   */
  readonly classicScrollbars?: boolean
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
  /** The app's log file (`docs/logs.md`), in the test's throwaway data folder: every launch in a test adds to it. */
  readonly logFile: string
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
  /**
   * The test's throwaway data folder, which every launch in the test uses: a spec can put things in it before a launch,
   * such as plugins in its plugins folder (`pluginsFolder`).
   */
  userData: string
}

/** Environment for the app: the e2e spec, and nothing that would make it run as Node or load a dev server. */
function appEnv(
  spec: E2eSpec,
  chosenFolder: string | undefined,
  timeZone: string,
  overrides: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE' && key !== 'ELECTRON_RENDERER_URL') env[key] = value
  }
  env.TZ = timeZone
  Object.assign(env, overrides)
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

  userData: async ({ tempFolder }, use) => {
    await use(tempFolder('glade-e2e-data-'))
  },

  launch: async ({ userData }, use, testInfo) => {
    const launched: Glade[] = []
    const name = videoName(testInfo.file, testInfo.title)
    // Chosen once, so a test's relaunches share the zone even if the hour turns in between.
    const timeZone = timeZoneAtHour(LOCAL_HOUR)

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

    await use(async (options = {}) => {
      const {
        route = '',
        chosenFolder,
        agentScript,
        agentScriptsByFirstMessage,
        seed,
        loginShell,
        env = {},
        motion = false,
        classicScrollbars = false,
      } = options
      const spec: E2eSpec = {
        userData,
        route,
        ...(agentScript === undefined ? {} : { agentScript }),
        ...(agentScriptsByFirstMessage === undefined ? {} : { agentScriptsByFirstMessage }),
        ...(seed === undefined ? {} : { seed }),
        ...(loginShell === undefined ? {} : { loginShell }),
      }
      // Electron on a missing script opens no window, and the launch would wait out the test's timeout. Playwright's
      // global setup builds it (scripts/e2e-setup.mjs); say so if it's gone anyway.
      if (!existsSync(MAIN)) throw new Error(`No test build at ${MAIN}: run the specs with npm run test:e2e`)
      const app = await electron.launch({
        args: [MAIN, ...(classicScrollbars ? CLASSIC_SCROLLBAR_ARGS : [])],
        env: appEnv(spec, chosenFolder, timeZone, env),
        ...(RECORD_DIR === undefined
          ? {}
          : { recordVideo: { dir: testInfo.outputPath('video'), size: E2E_WINDOW_SIZE, showActions: {} } }),
      })
      const window = await app.firstWindow()
      await window.emulateMedia({ reducedMotion: motion ? 'no-preference' : 'reduce' })
      const index = launched.length
      let closing: Promise<void> | undefined
      const glade: Glade = {
        app,
        window,
        close: () => (closing ??= closeApp(glade, index, false)),
        kill: () => (closing ??= closeApp(glade, index, true)),
        logFile: join(testModeLogsFolder(userData), LOG_FILE_NAME),
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
 * Opens the folder the dialog answers with (`chosenFolder`) from the first-run window, and waits until its workspace
 * shows. Opening it takes a few round trips to main, so a spec that goes on at once (opening a terminal, say) can beat
 * it on a slow machine: the terminal then starts in the fallback folder, as it does with no workspace open.
 */
export async function openWorkspace(window: Page): Promise<void> {
  await firstRun(window).openFolder.click()
  await expect(taskList(window).newTask).toBeVisible()
}

/** A bridge command main is holding (`holdCommand`). */
export interface HeldCommand {
  /** Waits until the window has sent the command, and main is holding it. */
  reached(): Promise<void>
  /** Lets it go: main runs it, and anything sent since, and stops holding. */
  release(): Promise<void>
}

/** What `holdCommand` keeps in main: whether the command has come, and how to let it go. */
interface CommandHold {
  reached: boolean
  release(): void
}

/** Where `holdCommand` keeps its hold, in main. */
const COMMAND_HOLD_GLOBAL = '__gladeE2eCommandHold'

/**
 * Holds main's answers to one bridge command, as a slow machine would, until the test lets them go: the command still
 * runs, in order, once released. It wraps the window's command handler in place, so it works on an app that's already
 * running. Electron keeps that handler in `ipcMain`'s `_invokeHandlers`; this fails loudly if it ever stops doing so.
 */
export async function holdCommand({ app }: Glade, command: CommandName): Promise<HeldCommand> {
  await app.evaluate(
    ({ ipcMain }, { channel, command, global }) => {
      type Handler = (event: unknown, name: unknown, request: unknown) => unknown
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as unknown
      const original = handlers instanceof Map ? (handlers.get(channel) as Handler | undefined) : undefined
      if (!(handlers instanceof Map) || original === undefined) throw new Error(`No handler for ${channel} to hold`)
      let letGo = (): void => undefined
      const held = new Promise<void>((resolve) => {
        letGo = resolve
      })
      const hold: CommandHold = {
        reached: false,
        release: () => {
          handlers.set(channel, original)
          letGo()
        },
      }
      Reflect.set(globalThis, global, hold)
      handlers.set(channel, async (event: unknown, name: unknown, request: unknown) => {
        if (name === command) {
          hold.reached = true
          await held
        }
        return original(event, name, request)
      })
    },
    { channel: COMMAND_CHANNEL, command, global: COMMAND_HOLD_GLOBAL },
  )
  return {
    reached: async () => {
      await expect
        .poll(() =>
          app.evaluate((_, global) => (Reflect.get(globalThis, global) as CommandHold).reached, COMMAND_HOLD_GLOBAL),
        )
        .toBe(true)
    },
    release: async () => {
      await app.evaluate((_, global) => {
        ;(Reflect.get(globalThis, global) as CommandHold).release()
      }, COMMAND_HOLD_GLOBAL)
    },
  }
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
 * What an artifact's Reveal in folder and Copy did so far: the real paths shown in Finder and the text put on the
 * clipboard, oldest first. An e2e run never opens Finder or touches the clipboard: main records them in their place
 * (`E2E_DESKTOP_GLOBAL`).
 */
export async function desktop({ app }: Glade): Promise<E2eDesktop> {
  return app.evaluate((_, name) => {
    const { revealed, copied } = Reflect.get(globalThis, name) as E2eDesktop
    return { revealed: [...revealed], copied: [...copied] }
  }, E2E_DESKTOP_GLOBAL)
}

/**
 * What the scripted agent was sent so far, oldest first: each message's content as the SDK backend would hand it to the
 * agent, its text or its image content blocks then its text (`E2E_AGENT_GLOBAL`).
 */
export async function agentReceived({ app }: Glade): Promise<E2eAgent['received']> {
  return app.evaluate((_, name) => [...(Reflect.get(globalThis, name) as E2eAgent).received], E2E_AGENT_GLOBAL)
}

/**
 * The sessions the scripted agent was started with so far, oldest first: each one's system prompt append and the
 * session it resumed (`E2E_AGENT_GLOBAL`).
 */
export async function agentSessions({ app }: Glade): Promise<E2eAgent['sessions']> {
  return app.evaluate((_, name) => [...(Reflect.get(globalThis, name) as E2eAgent).sessions], E2E_AGENT_GLOBAL)
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

/**
 * The environment each agent session started would have run in, oldest first: the app's e2e agents play scripts and
 * spawn nothing, so they record it instead.
 */
export async function agentEnvs({ app }: Glade): Promise<E2eAgentEnvs> {
  return app.evaluate((_, name) => Reflect.get(globalThis, name) as E2eAgentEnvs, E2E_AGENT_ENVS_GLOBAL)
}

/** The plugins folder in a test's data folder (`userData`), where Glade looks for plugins. */
export function pluginsFolder(userData: string): string {
  return join(userData, PLUGINS_FOLDER_NAME)
}
