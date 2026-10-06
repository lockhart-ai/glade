/**
 * A stand-in for the model, for the sandbox's escape battery (#516, `docs/escape-battery.md`): an e2e run may name a
 * server on this Mac that speaks enough of the Messages API to replay a fixed list of tool calls, and the app then runs
 * the real agent backend against it, so the bundled Claude Code and its sandbox run for real with no call to the real
 * API.
 *
 * No test may talk to the real Claude API (CLAUDE.md), and this is what keeps that true with the real backend in use:
 *
 * - **Only this Mac.** The stand-in, and the dead end below, are each `http://127.0.0.1:<port>` and nothing else
 *   (`isLoopbackEndpoint`): not a host name, not `localhost` (which a hosts file could point anywhere), not https.
 * - **The agent's process is given no other endpoint and no login.** `standInEnv` drops every variable that names an
 *   endpoint, a provider or a credential, then sets the stand-in as the base URL with a key that isn't one. There is
 *   nothing to fall back to: with the stand-in gone, the session's requests fail.
 * - **Every other host is a dead end.** The process's proxy is a second server on this Mac that refuses each request
 *   and notes its host, so anything the process itself sends elsewhere (a fetch, telemetry, the real API) goes nowhere,
 *   and the run that sent it fails.
 */
import type { Environment } from '../login-env'

/** Where an e2e run's stand-in model is. */
export interface StandInModel {
  /** The stand-in's Messages API: `http://127.0.0.1:<port>`. */
  readonly baseUrl: string
  /** The proxy every request for another host is sent to, which refuses it: `http://127.0.0.1:<port>`. */
  readonly deadEndProxy: string
}

/** The API key a session on a stand-in sends. It is no key: the stand-in checks that this is what arrives. */
export const STAND_IN_API_KEY = 'glade-stand-in-not-a-key'

/** The hosts a session on a stand-in reaches directly, past its proxy: this Mac's loopback address only. */
export const STAND_IN_NO_PROXY = '127.0.0.1'

const LOOPBACK_ENDPOINT = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/

/** Whether `url` is a plain HTTP endpoint on this Mac's loopback address, with a port and nothing after it. */
export function isLoopbackEndpoint(url: string): boolean {
  const port = LOOPBACK_ENDPOINT.exec(url)?.[1]
  return port !== undefined && Number(port) <= 65535
}

/** The variables that name a proxy, in both the cases tools read them in. */
const PROXY_VARIABLES: readonly string[] = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']

/**
 * Whether a variable could send the agent's process to another endpoint, or log it in: Anthropic's own (`ANTHROPIC_*`:
 * the base URL, a key, a token, custom headers), every one of Claude Code's (`CLAUDE*`: the switches to another
 * provider, its login tokens, the folder its login is kept in, and whatever a Claude Code session the run was started
 * from left in the environment, which would change how this one runs), a cloud provider's bearer token, and every
 * proxy. Glade's own additions to a session's environment are made after this (`SESSION_ENV`).
 */
function namesAnEndpointOrLogin(name: string): boolean {
  const upper = name.toUpperCase()
  return (
    upper.startsWith('ANTHROPIC_') ||
    upper.startsWith('CLAUDE') ||
    upper === 'AWS_BEARER_TOKEN_BEDROCK' ||
    PROXY_VARIABLES.includes(upper)
  )
}

/**
 * The environment a session on a stand-in runs in: `env` without anything that names an endpoint, a provider or a
 * login, then the stand-in as the only endpoint, a key that isn't one, and the dead end as the proxy for every host but
 * this Mac's loopback address. Claude Code's own optional traffic (telemetry, update checks) is turned off as well; if
 * any were sent anyway, the dead end would refuse it.
 */
export function standInEnv(env: Environment, standIn: StandInModel): Environment {
  const kept = Object.fromEntries(Object.entries(env).filter(([name]) => !namesAnEndpointOrLogin(name)))
  return {
    ...kept,
    ANTHROPIC_BASE_URL: standIn.baseUrl,
    ANTHROPIC_API_KEY: STAND_IN_API_KEY,
    ANTHROPIC_AUTH_TOKEN: STAND_IN_API_KEY,
    HTTP_PROXY: standIn.deadEndProxy,
    HTTPS_PROXY: standIn.deadEndProxy,
    http_proxy: standIn.deadEndProxy,
    https_proxy: standIn.deadEndProxy,
    NO_PROXY: STAND_IN_NO_PROXY,
    no_proxy: STAND_IN_NO_PROXY,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
}
