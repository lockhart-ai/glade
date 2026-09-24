/** A macOS home folder, `/Users/<name>`, at the start of a path. */
const HOME_PREFIX = /^\/Users\/[^/]+(?=\/|$)/

/**
 * Shortens a path under the user's home folder to start with `~`, as the designs show roots (`~/code/api`). The
 * sandboxed renderer can't ask for the home folder, so this recognises the macOS `/Users/<name>` layout.
 */
export function shortenHomePath(path: string): string {
  return path.replace(HOME_PREFIX, '~')
}
