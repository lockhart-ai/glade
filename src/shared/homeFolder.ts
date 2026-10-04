/**
 * The user's home folder, for showing paths under it from `~` as the designs do (`~/code/api`). Only the real home
 * folder is shortened: another user's folder (`/Users/someone/…`) is not yours, and a permission card that called it
 * `~` would name the wrong folder.
 *
 * Each process is told the home folder once, as it starts (`setHomeFolder`): main reads it from the OS, and a window,
 * whose sandboxed page can't ask, is created with it as an argument (`homeArgument`) that its preload reads
 * (`homeFromArguments`) and hands the page on the bridge (`GladeBridge.homeFolder`). Until it's told, nothing is
 * shortened. Captures and e2e runs show sample data, which lives under a made-up home (`SAMPLE_HOME`).
 */

/** The home folder the sample data in captures and e2e runs lives under: what they show as `~`. */
export const SAMPLE_HOME = '/Users/sample'

/** The argument a window is created with to name the home folder: `--glade-home=<absolute path>`. */
const HOME_ARGUMENT = '--glade-home='

let homeFolder: string | null = null

/** Tells this process the home folder, with no trailing slash; null for none known, when nothing is shortened. */
export function setHomeFolder(home: string | null): void {
  homeFolder = home === null || home === '' || home === '/' ? null : home.replace(/\/+$/, '')
}

/** The argument that names `home` to a window's preload (`BrowserWindow`'s `webPreferences.additionalArguments`). */
export function homeArgument(home: string): string {
  return `${HOME_ARGUMENT}${home}`
}

/** The home folder a window's arguments name (`process.argv` in its preload); null when none does. */
export function homeFromArguments(argv: readonly string[]): string | null {
  const argument = argv.find((one) => one.startsWith(HOME_ARGUMENT))
  return argument === undefined ? null : argument.slice(HOME_ARGUMENT.length)
}

/**
 * Shortens a path in the user's home folder to start with `~`, as the designs show folders (`~/code/api`). Any other
 * path is left as it is, another user's home folder included, and so is every path until the home folder is known.
 */
export function shortenHomePath(path: string): string {
  if (homeFolder === null) return path
  if (path === homeFolder) return '~'
  return path.startsWith(`${homeFolder}/`) ? `~${path.slice(homeFolder.length)}` : path
}
