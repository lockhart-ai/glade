/**
 * The control API's HTTP endpoint as the window sees it (Settings › Control; `docs/control-api.md`, "The HTTP
 * endpoint"): whether it's serving, where, with which token, and the command that connects Claude Code to it.
 */

/** The server's name, as the copy-ready command names it: never `glade`, which Glade's own tasks already have. */
export const CONTROL_SERVER_NAME = 'glade-control'

/** The port the endpoint listens on unless you choose another: "GLADE" on a phone keypad. */
export const DEFAULT_CONTROL_PORT = 45233

/** How many ports after the chosen one are tried when it's taken. */
export const CONTROL_PORT_FALLBACKS = 9

/** The ports you may choose: the unprivileged ones. */
export const MIN_CONTROL_PORT = 1024
export const MAX_CONTROL_PORT = 65535

/** The endpoint's path. */
export const CONTROL_PATH = '/mcp'

/** Whether a port may be chosen for the endpoint. */
export function isControlPort(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_CONTROL_PORT && port <= MAX_CONTROL_PORT
}

/** The endpoint's base URL on a port, which its paths are under. */
export function controlBaseUrl(port: number): string {
  return `http://127.0.0.1:${String(port)}`
}

/** The endpoint's MCP URL on a port. */
export function controlUrl(port: number): string {
  return `${controlBaseUrl(port)}${CONTROL_PATH}`
}

/** The command that connects Claude Code to the endpoint, ready to paste into a terminal. */
export function connectCommand(url: string, token: string): string {
  return `claude mcp add --transport http ${CONTROL_SERVER_NAME} ${url} --header "Authorization: Bearer ${token}"`
}

/** The endpoint as it is now. */
export interface ControlStatus {
  /** Whether Let agents control Glade is on. */
  readonly enabled: boolean
  /** The port chosen in Settings › Control. */
  readonly chosenPort: number
  /** The port it's listening on: the chosen one, or a fallback when that was taken. Null while it isn't listening. */
  readonly port: number | null
  /** Its URL, while it's listening. */
  readonly url: string | null
  /** The bearer token, once the switch has first gone on. */
  readonly token: string | null
  /** Why it isn't listening although the switch is on, e.g. every port it tried is taken. */
  readonly error: string | null
}
