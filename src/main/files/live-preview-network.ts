/**
 * What counts as "loopback" for the Files viewer's live preview (#764): a literal host — `localhost`, `127.0.0.1` or
 * `[::1]` — never a name that merely resolves to one (`localhost.example.com`, `127.0.0.1.nip.io`), never another
 * address on the loopback range (`127.0.0.2`), and never a userinfo trick (`http://localhost@evil.com`, whose
 * hostname is `evil.com`, which `URL` already separates from its `username`). One check, `isLoopbackUrl`, is shared
 * by the tool's own validation (`../agent/glade-tools.ts`, `show_file`'s `url`) and the live view's request filter
 * below, so the two can't drift apart.
 */

/** The literal loopback hosts a live preview may ever reach, at any port. Case-insensitive: `URL` lower-cases a host. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Whether `hostname`, as `URL` parses it, is a literal loopback host. */
function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname)
}

/**
 * Whether `raw` is a loopback page the live preview may load as its own URL (`show_file`'s `url`, and the tab it
 * opens): `http`, to `localhost`, `127.0.0.1` or `[::1]`, any port. Never `https` (loopback dev servers don't carry
 * one) and never `ws` (that's for the page's own requests, below, not a page to load).
 */
export function isLoopbackUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  return url.protocol === 'http:' && isLoopbackHost(url.hostname)
}

/**
 * Whether a live preview's session lets a request through (`webRequest.onBeforeRequest`): plain HTTP or WebSocket to
 * a loopback host (Vite's hot-reload socket needs `ws`), or a `data:`/`blob:` URL the page made itself (a canvas
 * export, an in-memory audio buffer). Everything else — HTTPS anywhere, another host, another scheme — is cancelled,
 * whatever the page asked for.
 */
export function isAllowedLivePreviewRequest(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  switch (url.protocol) {
    case 'data:':
    case 'blob:':
      return true
    case 'http:':
    case 'ws:':
      return isLoopbackHost(url.hostname)
    default:
      return false
  }
}
