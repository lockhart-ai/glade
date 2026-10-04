/**
 * The escape battery's own bounds (#516, `docs/escape-battery.md`): no attack may name anything outside the battery's
 * world and this Mac's loopback address. The spec checks every attack against this before any of them runs, so an
 * entry added later can't aim at a real path or a real host by mistake.
 *
 * What's checked is what can be: each absolute path, and each URL's host, anywhere in a call's input. A relative path
 * is from the workspace, and a bare host name in a command is the entry's own to keep under `OUTSIDE_DOMAIN`.
 */
import { OUTSIDE_DOMAIN, type AttackGroup } from './attacks'
import type { World } from './world'

/** The few real paths the battery names: what the floor reads, and the devices a command writes nothing to. */
const REAL_PATHS: readonly string[] = ['/usr/bin/true', '/etc/shells', '/dev/null']

/** Bash's name for a socket to the loopback address. */
const LOOPBACK_SOCKET = '/dev/tcp/127.0.0.1/'

/** The loopback address, and the zero address (which reaches it), as the URL parser gives a host in any spelling. */
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', '0.0.0.0', '[::1]', 'localhost', 'localhost.']

const URL_IN_TEXT = /\bhttps?:\/\/[^\s'"]+/gi

/**
 * An absolute path in a command or an input: a `/` that starts a word, up to where the word ends. Not a `/` inside a
 * word (`~/notes.txt`, `$HOME/notes.txt`, `../..`), nor the `/*` after a quoted folder.
 */
const PATH_IN_TEXT = /(?<![\w.~$}*/-])\/[^\s'";|&<>()*][^\s'";|&<>()]*/g

/** The whole disk, named by itself. */
const WHOLE_DISK = /(?:^|[\s'"=])\/(?=$|[\s'";|&<>()])/

/** Whether a URL's host is this Mac's loopback address, or a name under the battery's own `.invalid` domain. */
function isBatteryHost(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    // Not a URL any tool could fetch: nothing is named.
    return true
  }
  const name = host.endsWith('.') ? host.slice(0, -1) : host
  return LOOPBACK_HOSTS.includes(host) || name === OUTSIDE_DOMAIN || name.endsWith(`.${OUTSIDE_DOMAIN}`)
}

/** Whether an absolute path is in the battery's world, by any of the spellings the attacks use, or one of `REAL_PATHS`. */
function isBatteryPath(world: World, path: string): boolean {
  const roots = [world.root, world.userData]
  const spelled = roots.flatMap((root) => [
    root,
    `/System/Volumes/Data${root}`,
    `/.nofollow${root}`,
    `/.resolve/1${root}`,
    ...(root.startsWith('/private/') ? [root.slice('/private'.length)] : []),
  ])
  const inside = (root: string): boolean => path === root || path.startsWith(`${root}/`)
  return (
    spelled.some(inside) ||
    // A file by its device and inode: the world's own files are the only ones the battery looks up.
    path.startsWith('/.vol/') ||
    path.startsWith(LOOPBACK_SOCKET) ||
    REAL_PATHS.includes(path)
  )
}

/** The fields of a call's input that are words for a person or a model to read, which no tool acts on. */
const PROSE: readonly string[] = ['description', 'reason', 'prompt']

/** Every string a tool would act on, anywhere in a call's input. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, inner]) => (PROSE.includes(key) ? [] : strings(inner)))
}

/**
 * What the attacks name that they mustn't: each as a line saying which attack, and what. Empty when every absolute
 * path is in the battery's world and every URL's host is the loopback address or under `OUTSIDE_DOMAIN`.
 */
export function strayNames(world: World, groups: readonly AttackGroup[]): string[] {
  const strays: string[] = []
  for (const { attacks } of groups) {
    for (const { id, input } of attacks) {
      const given = typeof input === 'function' ? input(new Map()) : input
      for (const text of strings(given)) {
        for (const url of text.match(URL_IN_TEXT) ?? []) {
          if (!isBatteryHost(url)) strays.push(`${id} names a host outside the battery: ${url}`)
        }
        const rest = text.replaceAll(URL_IN_TEXT, ' ')
        for (const path of rest.match(PATH_IN_TEXT) ?? []) {
          if (!isBatteryPath(world, path)) strays.push(`${id} names a path outside the battery: ${path}`)
        }
        if (WHOLE_DISK.test(rest)) strays.push(`${id} names the whole disk`)
      }
    }
  }
  return strays
}
