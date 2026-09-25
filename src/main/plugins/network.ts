import { PLUGIN_SCHEME } from '../../shared/plugin-api'

/** The hosts a plugin may reach: this machine, as its CSP names it. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1'])

/**
 * Whether a plugin's session lets a request through (`webRequest.onBeforeRequest`): its own files, data and blob URLs,
 * and plain HTTP or WebSocket to localhost, which is what its CSP allows. Everything else, including another plugin's
 * files, HTTPS anywhere and any other scheme, is cancelled, whatever the page's CSP let past.
 */
export function isAllowedPluginRequest(raw: string, id: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  switch (url.protocol) {
    case `${PLUGIN_SCHEME}:`:
      return url.hostname === id
    case 'data:':
    case 'blob:':
      return true
    case 'http:':
    case 'ws:':
      return LOCAL_HOSTS.has(url.hostname)
    default:
      return false
  }
}
