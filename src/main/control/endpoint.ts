/**
 * The HTTP endpoint's lifecycle (`docs/control-api.md`, "Turning it on"): it listens while Let agents control Glade is
 * on and not while it's off, on the chosen port or, when that's taken, the first free one of the next nine.
 *
 * `sync` brings it in line with the settings: started when the switch is on (at launch too), stopped when it goes off,
 * restarted on the new port when the chosen one changes. Syncs run one at a time, in order, so flipping the switch
 * quickly leaves one endpoint or none, never two. The token is made the first time the switch goes on; regenerating it
 * applies to the next request at once and closes nothing. Each change of what Settings › Control shows is broadcast as
 * `control.changed`.
 */
import type { Database } from 'better-sqlite3'
import { EventType } from '../../shared/bridge'
import {
  CONTROL_PORT_FALLBACKS,
  controlBaseUrl,
  controlUrl,
  MAX_CONTROL_PORT,
  type ControlStatus,
} from '../../shared/control'
import type { Emit } from '../bridge/events'
import { getSettings } from '../db/repositories/settings'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import {
  CONTROL_HOST,
  listenControlHttp,
  PortsTakenError,
  type ControlHttpOptions,
  type ControlHttpServer,
} from './http'
import { ensureControlToken, readControlToken, regenerateControlToken } from './token'

export interface ControlEndpointOptions extends Pick<ControlHttpOptions, 'control' | 'limiter' | 'maxBodyBytes'> {
  readonly db: Database
  readonly emit: Emit
  /** Where it logs, in the `control` scope. */
  readonly log?: Logger
  /** The address it listens on: `127.0.0.1`, always, outside tests of that. */
  readonly host?: string
}

export interface ControlEndpoint {
  /** What Settings › Control shows. */
  status(): ControlStatus
  /** Starts, stops or moves the endpoint to match the settings; answers once it has, with the status. */
  sync(): Promise<ControlStatus>
  /** Replaces the token; the old one is refused from the next request. */
  regenerateToken(): ControlStatus
  /** Stops the endpoint, for good: a sync after this does nothing. */
  close(): Promise<void>
}

/** The variables Glade's own agents get while the endpoint listens, so scripts they run can call it. */
export enum ControlEnv {
  /** The endpoint's base URL, e.g. `http://127.0.0.1:45233`: `/v1/tools` and `/mcp` are under it. */
  Url = 'GLADE_CONTROL_URL',
  /** Its bearer token. */
  Token = 'GLADE_CONTROL_TOKEN',
}

/** The variables for a session starting now: the endpoint's URL and token while it listens, and none otherwise. */
export function controlEnv(status: ControlStatus): Readonly<Record<string, string>> {
  if (!status.enabled || status.port === null || status.token === null) return {}
  return { [ControlEnv.Url]: controlBaseUrl(status.port), [ControlEnv.Token]: status.token }
}

/** The ports tried for a chosen one: it, then the next nine, as far as there are ports. */
export function candidatePorts(chosen: number): number[] {
  const last = Math.min(chosen + CONTROL_PORT_FALLBACKS, MAX_CONTROL_PORT)
  return Array.from({ length: last - chosen + 1 }, (_, index) => chosen + index)
}

/** The endpoint while it listens, and the port that was chosen when it started. */
interface Running {
  readonly server: ControlHttpServer
  readonly chosenPort: number
}

export function createControlEndpoint(options: ControlEndpointOptions): ControlEndpoint {
  const { db, emit } = options
  const log = options.log ?? SILENT_LOGGER
  const host = options.host ?? CONTROL_HOST
  let running: Running | null = null
  let error: string | null = null
  let closed = false
  // The syncs, one after another.
  let queue: Promise<unknown> = Promise.resolve()
  // What was last broadcast, to broadcast only changes.
  let shown = ''

  const status = (): ControlStatus => {
    const settings = getSettings(db)
    const port = running?.server.port ?? null
    return {
      enabled: settings.controlEnabled,
      chosenPort: settings.controlPort,
      port,
      url: port === null ? null : controlUrl(port),
      token: readControlToken(db),
      error,
    }
  }

  const announce = (): ControlStatus => {
    const now = status()
    const key = JSON.stringify(now)
    if (key !== shown) {
      shown = key
      emit({ type: EventType.ControlChanged, status: now })
    }
    return now
  }

  const stop = async (): Promise<void> => {
    if (running === null) return
    const { server } = running
    running = null
    await server.close()
    log.info('control endpoint stopped', { port: server.port })
  }

  const start = async (chosenPort: number): Promise<void> => {
    const http: ControlHttpOptions = {
      control: options.control,
      limiter: options.limiter,
      log,
      token: () => readControlToken(db),
      ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    }
    try {
      const server = await listenControlHttp(http, candidatePorts(chosenPort), host)
      running = { server, chosenPort }
      error = null
      const fallback = server.port === chosenPort ? {} : { chosenPort, fallback: true }
      log.info('control endpoint started', { host, port: server.port, ...fallback })
    } catch (thrown) {
      error = thrown instanceof PortsTakenError ? thrown.message : `The endpoint couldn't start: ${String(thrown)}`
      log.error('control endpoint failed to start', { chosenPort, error: thrown })
    }
  }

  const reconcile = async (): Promise<void> => {
    if (closed) return
    const settings = getSettings(db)
    if (!settings.controlEnabled) {
      await stop()
      error = null
      return
    }
    ensureControlToken(db)
    if (running !== null && running.chosenPort === settings.controlPort) return
    await stop()
    await start(settings.controlPort)
  }

  return {
    status,
    sync() {
      const next = queue.then(reconcile).then(announce)
      queue = next.catch(() => undefined)
      return next
    },
    regenerateToken() {
      regenerateControlToken(db)
      log.info('control token regenerated')
      return announce()
    },
    close() {
      closed = true
      const next = queue.then(stop)
      queue = next
      return next
    },
  }
}
