// #486: a spec runs a function in the main process with `inMain` (./in-main), which has main run it on a turn of its
// own. Playwright's `app.evaluate` runs it inside whatever main is doing instead: once in CI, a click on the menu bar
// icon ran inside one of main's own queries, and its read of what's in flight threw "This database connection is busy
// executing a query" (focus-on-select.spec.ts). Here the window keeps main reading, so a function sent with
// `app.evaluate` does land inside a query, and `inMain` is held to never doing so.
import type { Page } from '@playwright/test'
import { BRIDGE_KEY, CommandName, type GladeBridge } from '../src/shared/bridge'
import { clickMenuBarIcon, expect, seedPath, test } from './fixtures'
import { inMain } from './in-main'
import { menuBarPopover } from './selectors'

/** The page's flag for whether it keeps main reading (`keepMainReading`). */
const READING_GLOBAL = '__gladeKeepsMainReading'

/** What the page asks main for, each a read of the database that takes no request. */
const READS = [CommandName.WorkspacesList, CommandName.UiStateGetAll, CommandName.SettingsGet] as const

/** How many reads of each kind the page has on their way to main at once. */
const READERS = 4

/** The main process's script, as a stack trace names it: a frame of it is main's own code. */
const MAIN_SCRIPT = 'out/testing/main/index.js'

/**
 * A stack trace from inside a query: under one of the functions better-sqlite3 calls while its connection is still
 * busy with the statement, to make a row of what it read or the list of them (`lib/database.js` there). A query run
 * from under one throws.
 */
const INSIDE_A_QUERY = /(rowFactory|arrayFactory|arrayAppender) \(.*better-sqlite3/

/** How many functions `app.evaluate` gets to land one inside a query; while main reads, about one in ten does. */
const EVALUATE_TRIES = 5000

/** How many functions `inMain` runs, none of which may land inside anything of main's. */
const IN_MAIN_RUNS = 300

/** Has the page ask main for its workspaces, UI state and settings over and over, so main is always reading. */
async function keepMainReading(window: Page): Promise<void> {
  await window.evaluate(
    ({ key, flag, readers, commands }) => {
      const bridge = (globalThis as unknown as Record<string, GladeBridge | undefined>)[key]
      if (bridge === undefined) throw new Error('No bridge on the page')
      Reflect.set(globalThis, flag, true)
      const read = async (): Promise<void> => {
        while (Reflect.get(globalThis, flag) === true)
          await Promise.all(commands.map((command) => bridge.invoke(command, {})))
      }
      for (let reader = 0; reader < readers; reader++) void read()
    },
    { key: BRIDGE_KEY, flag: READING_GLOBAL, readers: READERS, commands: READS },
  )
}

/** Lets main rest. */
async function stopReading(window: Page): Promise<void> {
  await window.evaluate((flag) => Reflect.set(globalThis, flag, false), READING_GLOBAL)
}

/** What main is running as this runs in it: the stack, deep enough to reach whatever this runs inside. */
function whereMainIs(): string {
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = 50
  const { stack = '' } = new Error('where main is')
  Error.stackTraceLimit = limit
  return stack
}

test('a function run with inMain never runs inside one of main’s queries, where one sent with app.evaluate does', async ({
  launch,
}) => {
  const glade = await launch({ seed: seedPath('menu-bar.json') })
  const { app, window } = glade
  await keepMainReading(window)

  // The bug: sent with Playwright's own `app.evaluate`, a function soon runs inside a query main is in the middle of.
  let inside: string | undefined
  for (let tries = 0; inside === undefined && tries < EVALUATE_TRIES; tries++) {
    // eslint-disable-next-line no-restricted-syntax -- What `inMain` is there in place of, to show what it does.
    const stack = await app.evaluate(whereMainIs)
    if (INSIDE_A_QUERY.test(stack)) inside = stack
  }
  expect(inside, 'No function sent with app.evaluate ran inside a query: is main still reading?').toBeDefined()
  expect(inside).toContain(MAIN_SCRIPT)

  // Run with `inMain`, it never does: nothing of main's is under it, a query or anything else.
  for (let run = 0; run < IN_MAIN_RUNS; run++) {
    const stack = await inMain(app, whereMainIs)
    expect(stack).not.toMatch(INSIDE_A_QUERY)
    expect(stack).not.toContain(MAIN_SCRIPT)
  }

  // So the click that failed opens the popover, which reads what's in flight as it shows, while main reads on.
  const popover = menuBarPopover(await clickMenuBarIcon(glade))
  await expect(popover.rows('Needs you')).toHaveCount(1)
  await expect(popover.rows('Working')).toHaveCount(1)
  await stopReading(window)
})

test('inMain hands the function Electron’s module and its argument, and answers with what it returns or throws', async ({
  launch,
}) => {
  const { app } = await launch()
  expect(await inMain(app, ({ app: electronApp }) => electronApp.isReady())).toBe(true)
  expect(await inMain(app, (_, { left, right }) => left + right, { left: 2, right: 3 })).toBe(5)
  expect(await inMain(app, (_, nothing) => typeof nothing)).toBe('undefined')
  // A promise is waited for.
  const later = inMain(
    app,
    (_, text) =>
      new Promise<string>((resolve) => {
        setTimeout(() => {
          resolve(text.toUpperCase())
        }, 1)
      }),
    'held',
  )
  expect(await later).toBe('HELD')
  // What it throws, at once or later, reaches the spec.
  const thrown = inMain(app, () => {
    throw new Error('Nothing of the kind in main')
  })
  await expect(thrown).rejects.toThrow('Nothing of the kind in main')
  const rejected = inMain(app, () => Promise.reject(new Error('Nor later')))
  await expect(rejected).rejects.toThrow('Nor later')
})
