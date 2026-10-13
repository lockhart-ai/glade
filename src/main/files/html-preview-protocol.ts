/**
 * Serving a static HTML file's own folder under `glade-html-preview://preview/` (`docs/product.md`, "Preview"), for
 * the Files viewer's HTML preview alone: nothing outside the folder is served however the path is spelt (`..`,
 * `%2e%2e`, `%2F`, a symlink out). This reuses the plugin sandbox's own folder-serving (`../plugins/protocol.ts`,
 * `resolvePluginFile`), which takes any folder and already resolves symlinks safely; only the scheme, the CSP and the
 * host check differ, since each preview's session serves one file's folder alone, never another plugin's or a
 * second preview's.
 */
import { readFile } from 'node:fs/promises'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import { mediaTypeOf, resolvePluginFile } from '../plugins/protocol'

/** The scheme the preview's page and its own files load from; `preview` is the only host it answers for. */
export const HTML_PREVIEW_SCHEME = 'glade-html-preview'

/** The preview's one page, at its scheme's root. */
export const HTML_PREVIEW_HOST = 'preview'

/**
 * The Content-Security-Policy every preview response carries: the file's own folder, and inline script and style
 * (an agent's static report is one file with its script and style inline or beside it); nothing else, offline (Jared,
 * #614): no network, no frames, objects or forms.
 */
export const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

/** The headers every response to the preview carries. */
function headers(extra: Readonly<Record<string, string>> = {}): Headers {
  return new Headers({
    'Content-Security-Policy': HTML_PREVIEW_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...extra,
  })
}

function refusal(status: number): Response {
  return new Response(null, { status, headers: headers() })
}

/** Where a preview's files come from: the HTML file's own folder, resolved and fixed for this preview's session. */
export interface HtmlPreviewFiles {
  readonly folder: string
  readonly log?: Logger
}

/**
 * Answers the preview's requests on its scheme (`protocol.handle`): a GET or HEAD of a file in the folder, with the
 * CSP. Another host, another method, or a path that isn't a file in the folder gets a 404 (or 405), and is logged.
 */
export function createHtmlPreviewFileHandler({ folder, log = SILENT_LOGGER }: HtmlPreviewFiles) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.hostname !== HTML_PREVIEW_HOST) {
      log.warn('html preview asked for another host', { url: request.url })
      return refusal(404)
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return refusal(405)
    const file = await resolvePluginFile(folder, url.pathname)
    if (file === null) {
      log.warn('html preview file refused', { path: url.pathname })
      return refusal(404)
    }
    const body = request.method === 'HEAD' ? null : await readFile(file)
    return new Response(body, { status: 200, headers: headers({ 'Content-Type': mediaTypeOf(file) }) })
  }
}

/** The preview's first (and only) URL: the HTML file, at the scheme's root. */
export function htmlPreviewEntryUrl(fileName: string): string {
  return `${HTML_PREVIEW_SCHEME}://${HTML_PREVIEW_HOST}/${fileName.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * Whether a request the preview's session sees may go ahead: only its own scheme, whatever path, which the file
 * handler above checks is really in the folder. Everything else — HTTPS, HTTP, WebSocket, `data:`, `file:`, another
 * scheme — is cancelled: the preview is offline (Jared, #614).
 */
export function isAllowedHtmlPreviewRequest(raw: string): boolean {
  try {
    return new URL(raw).protocol === `${HTML_PREVIEW_SCHEME}:`
  } catch {
    return false
  }
}

/**
 * Registers the preview's scheme as a standard, secure one, so its page has an origin of its own for its CSP's
 * `'self'` and relative URLs, and can `fetch` its own files. Call before the app is ready.
 */
export function registerHtmlPreviewScheme(protocol: Pick<Electron.Protocol, 'registerSchemesAsPrivileged'>): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: HTML_PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ])
}
