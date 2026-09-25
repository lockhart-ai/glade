// The HTTP endpoint's lifecycle under stress: it follows the switch and the port, falls back when the chosen port is
// taken and says so, fails visibly when every port is, moves when the port changes, and flipping the switch quickly
// leaves one endpoint or none, never two.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CommandName, EventType, type ControlChangedEvent } from '../../shared/bridge'
import { CONTROL_PORT_FALLBACKS, controlUrl, DEFAULT_CONTROL_PORT, MAX_CONTROL_PORT } from '../../shared/control'
import { updateSettings } from '../db/repositories/settings'
import { createControl } from './control'
import { candidatePorts, controlEnv, createControlEndpoint } from './endpoint'
import { createRateLimiter } from './rate-limit'
import { startControlApp, type ControlApp } from './test-control'
import { freePortRun, goodHeaders, rawRequest, takePort, toolCallBody, type HeldPort } from './test-http'
import { ControlToolName } from './names'
import { readControlToken } from './token'

let app: ControlApp
let chosen: number
const held: HeldPort[] = []

beforeEach(async () => {
  app = startControlApp(false)
  chosen = await freePortRun(CONTROL_PORT_FALLBACKS + 2)
})

afterEach(async () => {
  for (const port of held.splice(0)) await port.release()
  await app.close()
})

async function take(port: number): Promise<void> {
  held.push(await takePort(port))
}

function update(patch: { controlEnabled?: boolean; controlPort?: number }) {
  return app.glade.invoke(CommandName.SettingsUpdate, { patch })
}

async function status() {
  return (await app.glade.invoke(CommandName.ControlStatus, {})).status
}

/** Whether the endpoint answers on `port`, as itself. */
async function answers(port: number): Promise<boolean> {
  const token = readControlToken(app.database.db) ?? ''
  try {
    const response = await rawRequest({
      port,
      headers: goodHeaders(token),
      body: toolCallBody(ControlToolName.ListWorkspaces),
    })
    return response.status === 200
  } catch {
    return false
  }
}

/** The ports of the run the endpoint answers on. */
async function serving(): Promise<number[]> {
  const ports = candidatePorts(chosen)
  const up = await Promise.all(ports.map(answers))
  return ports.filter((_, index) => up[index])
}

function changes(): ControlChangedEvent[] {
  return app.events.filter((event): event is ControlChangedEvent => event.type === EventType.ControlChanged)
}

describe('the switch', () => {
  it('off, as it starts: nothing listens, and there is no token yet', async () => {
    await app.bridge.endpoint.sync()

    expect(await status()).toEqual({
      enabled: false,
      chosenPort: DEFAULT_CONTROL_PORT,
      port: null,
      url: null,
      token: null,
      error: null,
    })
    expect(changes()).toHaveLength(1)
  })

  it('on: listens on the chosen port with a token made now, and says so', async () => {
    await update({ controlPort: chosen })
    await update({ controlEnabled: true })

    const now = await status()
    expect(now).toMatchObject({ enabled: true, chosenPort: chosen, port: chosen, url: controlUrl(chosen), error: null })
    expect(now.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await serving()).toEqual([chosen])
    expect(changes().at(-1)?.status).toEqual(now)
    expect(app.log.withMessage('control endpoint started')[0]?.fields).toEqual({ host: '127.0.0.1', port: chosen })
  })

  it('off again: stops listening, keeping the token for next time', async () => {
    await update({ controlPort: chosen, controlEnabled: true })
    const { token } = await status()

    await update({ controlEnabled: false })

    expect(await status()).toMatchObject({ enabled: false, port: null, url: null, token })
    expect(await serving()).toEqual([])
    expect(app.log.withMessage('control endpoint stopped')).toHaveLength(1)
    await update({ controlEnabled: true })
    expect((await status()).token).toBe(token)
  })

  it('flipped quickly many times leaves one endpoint or none, never two', async () => {
    await update({ controlPort: chosen })
    const flips = Array.from({ length: 11 }, (_, index) => update({ controlEnabled: index % 2 === 0 }))
    await Promise.all(flips)

    // The last flip turned it on: exactly one endpoint, on the chosen port.
    expect(await serving()).toEqual([chosen])
    expect((await status()).port).toBe(chosen)
    const started = app.log.withMessage('control endpoint started').length
    const stopped = app.log.withMessage('control endpoint stopped').length
    expect(started - stopped).toBe(1)

    await Promise.all([
      update({ controlEnabled: false }),
      update({ controlEnabled: true }),
      update({ controlEnabled: false }),
    ])
    expect(await serving()).toEqual([])
  })

  it('on at launch: the first sync starts it', async () => {
    updateSettings(app.database.db, { controlEnabled: true, controlPort: chosen })

    await app.bridge.endpoint.sync()

    expect(await serving()).toEqual([chosen])
  })
})

describe('the port', () => {
  it('taken: the next free one is used, and the status says it is not the chosen one', async () => {
    await take(chosen)
    await take(chosen + 1)

    await update({ controlPort: chosen, controlEnabled: true })

    expect(await status()).toMatchObject({ chosenPort: chosen, port: chosen + 2, url: controlUrl(chosen + 2) })
    expect(await serving()).toEqual([chosen + 2])
    expect(app.log.withMessage('control endpoint started')[0]?.fields).toEqual({
      host: '127.0.0.1',
      port: chosen + 2,
      chosenPort: chosen,
      fallback: true,
    })
  })

  it('and all nine after it taken: nothing listens, and the error says which', async () => {
    for (const port of candidatePorts(chosen)) await take(port)

    await update({ controlPort: chosen, controlEnabled: true })

    const last = chosen + CONTROL_PORT_FALLBACKS
    expect(await status()).toMatchObject({
      enabled: true,
      port: null,
      url: null,
      error: `Ports ${String(chosen)}–${String(last)} are all in use.`,
    })
    expect(app.log.withMessage('control endpoint failed to start')[0]?.fields).toMatchObject({ chosenPort: chosen })
    // Freed, it starts once the switch is flipped again, and the error goes.
    for (const port of held.splice(0)) await port.release()
    await update({ controlEnabled: false })
    expect((await status()).error).toBeNull()
    await update({ controlEnabled: true })
    expect(await status()).toMatchObject({ port: chosen, error: null })
  })

  it('changed while serving: the old port closes, the new one serves', async () => {
    await update({ controlPort: chosen, controlEnabled: true })
    const moved = await freePortRun(1)

    await update({ controlPort: moved })

    expect(await status()).toMatchObject({ chosenPort: moved, port: moved })
    expect(await answers(moved)).toBe(true)
    expect(await answers(chosen)).toBe(false)
  })

  it('set again to the one it has: nothing restarts', async () => {
    await update({ controlPort: chosen, controlEnabled: true })

    await update({ controlPort: chosen })

    expect(app.log.withMessage('control endpoint started')).toHaveLength(1)
  })

  it('near the top of the range: only the ports there are are tried', () => {
    expect(candidatePorts(MAX_CONTROL_PORT - 2)).toEqual([MAX_CONTROL_PORT - 2, MAX_CONTROL_PORT - 1, MAX_CONTROL_PORT])
    expect(candidatePorts(DEFAULT_CONTROL_PORT)).toHaveLength(CONTROL_PORT_FALLBACKS + 1)
  })

  it('only one of them taken says "Port … is in use"', async () => {
    const top = MAX_CONTROL_PORT
    const endpoint = createControlEndpoint({
      db: app.database.db,
      emit: () => undefined,
      control: app.bridge.control,
      limiter: createRateLimiter(),
    })
    updateSettings(app.database.db, { controlEnabled: true, controlPort: top })
    const blocker = await takePort(top).catch(() => null)

    const now = await endpoint.sync()

    // Held here, or already by something else on this machine: either way it's taken.
    expect(now.error).toBe(`Port ${String(top)} is in use.`)
    await blocker?.release()
    await endpoint.close()
  })
})

describe('the token, regenerated', () => {
  it('is broadcast, and the endpoint keeps listening where it was', async () => {
    await update({ controlPort: chosen, controlEnabled: true })
    const before = await status()

    const { status: after } = await app.glade.invoke(CommandName.ControlRegenerateToken, {})

    expect(after.token).not.toBe(before.token)
    expect(after.port).toBe(before.port)
    expect(changes().at(-1)?.status).toEqual(after)
    expect(app.log.withMessage('control endpoint stopped')).toHaveLength(0)
    expect(app.log.withMessage('control token regenerated')).toHaveLength(1)
  })
})

describe('an address it cannot listen on', () => {
  it('is an error the status shows, not a crash', async () => {
    const endpoint = createControlEndpoint({
      db: app.database.db,
      emit: () => undefined,
      control: createControl({ db: app.database.db, emit: () => undefined, runner: app.bridge.runner }),
      limiter: createRateLimiter(),
      // Not an address of this machine.
      host: '203.0.113.1',
    })
    updateSettings(app.database.db, { controlEnabled: true, controlPort: chosen })

    const now = await endpoint.sync()

    expect(now.port).toBeNull()
    expect(now.error).toMatch(/^The endpoint couldn't start: /)
    await endpoint.close()
  })
})

describe('closing', () => {
  it('stops the endpoint for good: a sync after it starts nothing', async () => {
    await update({ controlPort: chosen, controlEnabled: true })

    await app.bridge.endpoint.close()
    await app.bridge.endpoint.sync()

    expect(await serving()).toEqual([])
  })
})

describe('controlEnv', () => {
  it('is the base URL and token while it listens, and nothing otherwise', () => {
    const on = { enabled: true, chosenPort: chosen, port: chosen, url: controlUrl(chosen), token: 't', error: null }

    expect(controlEnv(on)).toEqual({
      GLADE_CONTROL_URL: `http://127.0.0.1:${String(chosen)}`,
      GLADE_CONTROL_TOKEN: 't',
    })
    expect(controlEnv({ ...on, enabled: false })).toEqual({})
    expect(controlEnv({ ...on, port: null, url: null, error: 'Ports are all in use.' })).toEqual({})
    expect(controlEnv({ ...on, token: null })).toEqual({})
  })
})
