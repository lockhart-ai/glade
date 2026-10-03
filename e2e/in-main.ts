/**
 * Runs a function in the app's main process, for the specs: `inMain` in place of Playwright's `app.evaluate` (#486).
 *
 * `app.evaluate` reaches main over Node's inspector, and the inspector doesn't wait for main to finish what it's doing:
 * it interrupts the JavaScript main is running, at its next function call, and runs the function right there, inside
 * it. So a spec's click on the menu bar icon could run in the middle of one of main's own queries: better-sqlite3 calls
 * a function of its own for each row it reads (and for the list of them), while its connection is still marked busy,
 * and a query from inside that call throws "This database connection is busy executing a query". Nothing in the app
 * can do that to itself; only a function sent over the inspector lands there.
 *
 * `inMain` sends the same function, but has main run it on a turn of its event loop of its own (`setImmediate`),
 * between main's tasks, as a click or a command from the window would arrive. An ESLint rule keeps the specs from
 * calling `app.evaluate` themselves.
 */
import type { ElectronApplication } from '@playwright/test'

/** Electron's module as main has it: what a function run in main is handed first, as `app.evaluate` hands it. */
type ElectronModule = typeof import('electron')

/**
 * A function for main to run. It's sent as its source, so it can use Electron's module, the argument sent with it and
 * main's globals, and nothing else of the spec's.
 */
export type MainFunction<Arg, R> = (electron: ElectronModule, arg: Arg) => R | Promise<R>

/** What `inMain` sends main: the function's source, and its argument. */
interface Sent<Arg> {
  readonly source: string
  readonly arg: Arg
}

/** Runs `fn` in the main process, on a turn of main's event loop of its own, and answers with what it returns. */
export function inMain<R>(app: ElectronApplication, fn: MainFunction<undefined, R>): Promise<R>
export function inMain<Arg, R>(app: ElectronApplication, fn: MainFunction<Arg, R>, arg: Arg): Promise<R>
export function inMain<Arg, R>(app: ElectronApplication, fn: MainFunction<Arg, R>, arg?: Arg): Promise<R> {
  const sent: Sent<Arg | undefined> = { source: fn.toString(), arg }
  // eslint-disable-next-line no-restricted-syntax -- The one `app.evaluate` there is: what it runs only waits its turn.
  return app.evaluate(async (electron, { source, arg: sentArg }) => {
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    // Main has the function's source, as `app.evaluate` itself would have sent it; this makes the function of it.
    const run = globalThis.eval(`(${source})`) as MainFunction<unknown, R>
    return run(electron, sentArg)
  }, sent)
}
