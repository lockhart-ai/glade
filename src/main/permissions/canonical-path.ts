/**
 * One spelling for a path, so the sandbox's folder checks (`./classify`) can't be dodged by another spelling of a folder
 * they deny: a symbolic link into it (`<root>/link/…` after `ln -s ~/Documents link`), macOS's alias for the data
 * volume (`/System/Volumes/Data/Users/…`), another case (`/users/ME/…`, on a volume that ignores case), or `~`.
 *
 * A path is resolved through the file system as far as it exists (`realpath`), following a link whose target doesn't
 * exist yet too, since a write would create it there; what doesn't exist is kept as written. The data volume's prefix is
 * dropped, and the result is compared as a key, lower-cased and in one Unicode form. A path that can't be resolved (a
 * loop of links) has no key, and whoever asks treats it as outside everything.
 *
 * **macOS's magic folders have no key either** (#514). `/.nofollow/<path>`, `/.vol/<device>/<inode>/<rest>` and
 * `/.resolve/<n>/<path>` each name any file on the disk by a path of their own, which `realpath` doesn't turn back
 * into the file's real one: `/.nofollow/Users/me/.ssh/id_rsa` reads the key, and compares as under none of the folders
 * the sandbox bounds. So a path that starts with one of them, in any case, or reaches one through a link, can't be
 * resolved: the file tools are refused it, and no grant can name it.
 */
import { readlinkSync, realpathSync } from 'node:fs'
import { isAbsolute, posix } from 'node:path'

/** What resolving a path reads of the file system. */
export interface PathFs {
  /** The path with every symbolic link in it followed; null when it doesn't exist, or can't be read. */
  realpath(path: string): string | null
  /** Where a symbolic link points, as written in it; null for anything that isn't one. */
  readlink(path: string): string | null
}

/** The real file system. */
export const NATIVE_FS: PathFs = {
  realpath(path) {
    try {
      return realpathSync.native(path)
    } catch {
      return null
    }
  },
  readlink(path) {
    try {
      return readlinkSync(path)
    } catch {
      return null
    }
  },
}

/** macOS's other name for everything on the data volume: `/System/Volumes/Data/Users/me` is `/Users/me`. */
const DATA_VOLUME = '/system/volumes/data'

/** The most links, one pointing at the next, a path is followed through before it's given up on. */
const MAX_LINKS = 40

/**
 * macOS's magic folders at the top of the disk, lower-cased: each names any file by another path (see the module
 * comment).
 */
const ALIAS_ROOTS: readonly string[] = ['/.nofollow', '/.vol', '/.resolve']

/** Whether an absolute, normalized path is in one of macOS's magic folders (`ALIAS_ROOTS`), in whatever case. */
export function isAliasPath(path: string): boolean {
  const key = offDataVolume(path).normalize('NFC').toLowerCase()
  return ALIAS_ROOTS.some((root) => key === root || key.startsWith(`${root}/`))
}

/** A path as two spellings of it compare: lower-cased, in one Unicode form, without the data volume's prefix. */
export function pathKey(path: string): string {
  const key = path.normalize('NFC').toLowerCase()
  if (key === DATA_VOLUME) return '/'
  return key.startsWith(`${DATA_VOLUME}/`) ? key.slice(DATA_VOLUME.length) : key
}

/** `path` as an absolute, normalized one: `~` is `home`, and a relative path is from `root`. */
export function absolutePath(path: string, root: string, home: string): string {
  if (path === '~') return posix.normalize(home)
  if (path.startsWith('~/')) return posix.join(home, path.slice(2))
  return posix.normalize(isAbsolute(path) ? path : posix.join(root, path))
}

/** A path without the data volume's prefix, in whatever case it's written: the rest is left as it is. */
function offDataVolume(path: string): string {
  const prefix = path.slice(0, DATA_VOLUME.length).toLowerCase()
  if (prefix !== DATA_VOLUME) return path
  if (path.length === DATA_VOLUME.length) return '/'
  return path[DATA_VOLUME.length] === '/' ? path.slice(DATA_VOLUME.length) : path
}

/**
 * Where an absolute path really is, as far as it exists (see the module comment), in the case the disk has it and
 * without the data volume's prefix: the one spelling to keep a folder by, so the same folder is never kept twice
 * (`../sandbox/grants`). What doesn't exist is kept as written. Null when it can't be resolved: a loop of links, or a
 * path in one of macOS's magic folders (`isAliasPath`), as written or once its links are followed.
 */
export function canonicalPath(path: string, fs: PathFs = NATIVE_FS): string | null {
  let existing = posix.normalize(path)
  // The parts after the deepest folder that exists, innermost first.
  const rest: string[] = []
  // The path put back together, unless it turned out to be in a magic folder.
  const whole = (resolved: string): string | null => {
    const joined = offDataVolume(posix.join(resolved, ...rest.toReversed()))
    return isAliasPath(joined) ? null : joined
  }
  for (let links = 0; links <= MAX_LINKS;) {
    // Before the disk is asked: `realpath` hands `/.nofollow/…` back as it is, and fails on the other two.
    if (isAliasPath(existing)) return null
    const real = fs.realpath(existing)
    if (real !== null) return whole(real)
    // A link to somewhere that doesn't exist yet: what's written through it lands at its target.
    const target = fs.readlink(existing)
    if (target !== null) {
      existing = posix.resolve(posix.dirname(existing), target)
      links += 1
      continue
    }
    const parent = posix.dirname(existing)
    // Nothing of it exists, not even `/`: as written.
    if (parent === existing) return whole(existing)
    rest.push(posix.basename(existing))
    existing = parent
  }
  return null
}

/**
 * The key of an absolute path (see the module comment): where it really is, as far as it exists. Null when it can't be
 * resolved.
 */
export function canonicalKey(path: string, fs: PathFs = NATIVE_FS): string | null {
  const real = canonicalPath(path, fs)
  return real === null ? null : pathKey(real)
}

/** Whether the path with key `key` is the folder with key `folder`, or inside it. */
export function keyInside(key: string, folder: string): boolean {
  if (folder === '/') return true
  return key === folder || key.startsWith(`${folder}/`)
}
