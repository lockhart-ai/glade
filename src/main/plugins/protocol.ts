/**
 * Serving a plugin's files under `glade-plugin://<id>/` (`docs/plugin-api.md`, "The sandbox"), from its own folder
 * only. Each plugin's session handles the scheme for that plugin alone, so one plugin can't read another's files, and
 * nothing outside the folder is served however the path is spelt: `..`, `%2e%2e`, `%2F`, a symlink out.
 */
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { SILENT_LOGGER, type Logger } from '../logging/logger'

/**
 * The Content-Security-Policy every plugin response carries: the plugin's own files, inline script and style, data and
 * blob images and fonts, and localhost for its own servers; nothing else. From `docs/plugin-api.md`.
 */
export const PLUGIN_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

/** The media type each kind of file a plugin page loads is served as; anything else is a download's, so it can't run. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
}

const DOWNLOAD_TYPE = 'application/octet-stream'

/** The media type a file is served as, by its extension. */
export function mediaTypeOf(path: string): string {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? DOWNLOAD_TYPE
}

/** Whether `path` is `root` or inside it. Both are absolute and resolved. */
function isWithin(root: string, path: string): boolean {
  const inside = relative(root, path)
  return inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)
}

/**
 * The file a URL's path names in a plugin's folder, resolved through any symlinks, or null when it isn't a file inside
 * the folder: it's outside (however it's spelt), missing, a folder, or the path can't be decoded.
 */
export async function resolvePluginFile(folder: string, pathname: string): Promise<string | null> {
  let path: string
  try {
    path = decodeURIComponent(pathname)
  } catch {
    return null
  }
  // A NUL cuts a path short in C; a backslash is a separator to some. Neither belongs in a plugin's file names.
  if (path.includes('\0') || path.includes('\\')) return null
  try {
    const root = await realpath(folder)
    const named = resolve(root, `.${path.startsWith('/') ? '' : '/'}${path}`)
    if (!isWithin(root, named)) return null
    // Resolving symlinks again: one inside the folder may point out of it.
    const file = await realpath(named)
    if (!isWithin(root, file)) return null
    return (await stat(file)).isFile() ? file : null
  } catch {
    return null
  }
}

/** Where a plugin's files come from. */
export interface PluginFiles {
  /** Its id, which is the only host its scheme answers for. */
  readonly id: string
  /** Its folder, whose files are all it serves. */
  readonly folder: string
  readonly log?: Logger
}

/** The headers every response to a plugin carries. */
function headers(extra: Readonly<Record<string, string>> = {}): Headers {
  return new Headers({
    'Content-Security-Policy': PLUGIN_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...extra,
  })
}

function refusal(status: number): Response {
  return new Response(null, { status, headers: headers() })
}

/**
 * Answers the plugin's requests on its scheme (`protocol.handle`): a GET or HEAD of a file in its folder, with the CSP.
 * Another plugin's host, another method, or a path that isn't a file in the folder gets a 404 (or 405), and is logged.
 */
export function createPluginFileHandler({ id, folder, log = SILENT_LOGGER }: PluginFiles) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.hostname !== id) {
      log.warn('plugin asked for another host', { id, url: request.url })
      return refusal(404)
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return refusal(405)
    const file = await resolvePluginFile(folder, url.pathname)
    if (file === null) {
      log.warn('plugin file refused', { id, path: url.pathname })
      return refusal(404)
    }
    const body = request.method === 'HEAD' ? null : await readFile(file)
    return new Response(body, { status: 200, headers: headers({ 'Content-Type': mediaTypeOf(file) }) })
  }
}
