// The machine's readings in the plugin views (#403): sent only to the shown plugin with the `machine` capability on,
// only while it's showing and has said `ready`, with the latest in its snapshot; and the monitor is listened to for
// exactly that long, so it samples only then.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PluginEventType,
  type PluginEvent,
  type PluginMachineReading,
  type PluginSnapshotEvent,
} from '../../shared/plugin-api'
import { gladeMessageSchema } from '../../shared/plugin-api-schema'
import { PluginCapability, PluginStatus, type ValidPlugin } from '../../shared/plugins'
import { createMemoryLog, type MemoryLog } from '../logging/memory-sink'
import { createFakePluginViews, type FakePluginViews } from './fake-view'
import type { PluginFeed } from './feed'
import type { MachineListener, MachineMonitor } from './machine'
import { createPluginViews, type PluginViews } from './views'

const bounds = { x: 600, y: 520, width: 680, height: 255 }

function plugin(folder: string, { asks = true, granted = true, enabled = true } = {}): ValidPlugin {
  return {
    status: PluginStatus.Valid,
    folder,
    manifest: {
      id: folder,
      name: folder,
      version: '1.0.0',
      entry: 'index.html',
      icon: null,
      capabilities: asks ? [PluginCapability.Machine] : [],
    },
    iconUrl: null,
    enabled,
    granted: asks && granted ? [PluginCapability.Machine] : [],
  }
}

function reading(t: number, total = 7.3): PluginMachineReading {
  return {
    t,
    cpuCount: 10,
    total,
    claude: 4.6,
    docker: 1.4,
    gpu: 88,
    containers: [{ name: 'acme-api-db-1', cpu: 78, memory: 440_401_920 }],
  }
}

/** A monitor a test drives: who's listening, and readings pushed to them. */
interface StubMonitor extends Pick<MachineMonitor, 'subscribe' | 'history'> {
  readonly listeners: Set<MachineListener>
  /** How many times anyone subscribed. */
  subscriptions: number
  push(next: PluginMachineReading): void
  readings: PluginMachineReading[]
}

function stubMonitor(): StubMonitor {
  const listeners = new Set<MachineListener>()
  const monitor: StubMonitor = {
    listeners,
    subscriptions: 0,
    readings: [],
    subscribe(listener) {
      monitor.subscriptions += 1
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    history: () => [...monitor.readings],
    push(next) {
      monitor.readings.push(next)
      for (const listener of listeners) listener(next)
    },
  }
  return monitor
}

const SNAPSHOT: PluginSnapshotEvent = {
  type: PluginEventType.Snapshot,
  tasks: [],
  subagents: [],
  questions: [],
  permissions: [],
}

const feed: Pick<PluginFeed, 'subscribe'> = {
  subscribe(sink) {
    sink(SNAPSHOT)
    return vi.fn()
  },
}

let fakes: FakePluginViews
let monitor: StubMonitor
let views: PluginViews
let log: MemoryLog

function create(machine: StubMonitor | null = monitor): PluginViews {
  return createPluginViews({
    emit: vi.fn(),
    feed,
    folder: '/data/plugins',
    appVersion: '0.19.0',
    createView: fakes.create,
    ...(machine === null ? {} : { machine }),
    log: log.logger,
  })
}

beforeEach(() => {
  fakes = createFakePluginViews()
  monitor = stubMonitor()
  log = createMemoryLog()
  views = create()
})

/** Every event the last view's page was sent, each checked against the schema. */
function events(): PluginEvent[] {
  return fakes.last().sent.map((message) => gladeMessageSchema.parse(message).event)
}

function readings(): PluginMachineReading[] {
  return events().flatMap((event) => (event.type === PluginEventType.MachineReading ? [event.reading] : []))
}

function snapshot(): PluginSnapshotEvent | undefined {
  return events().find((event): event is PluginSnapshotEvent => event.type === PluginEventType.Snapshot)
}

/** Shows `id` and has its page say `ready`. */
function showReady(id: string): void {
  views.place(id, bounds)
  fakes.last().post({ type: 'ready' })
}

describe('a plugin with the machine capability on', () => {
  beforeEach(() => {
    views.update([plugin('gauge')])
  })

  it('gets each reading as it comes, once it has said ready, numbered on from its snapshot', () => {
    views.place('gauge', bounds)
    expect(monitor.listeners.size).toBe(0)

    fakes.last().post({ type: 'ready' })
    expect(monitor.listeners.size).toBe(1)
    monitor.push(reading(1_000))
    monitor.push(reading(3_000, 9.1))

    expect(readings()).toEqual([reading(1_000), reading(3_000, 9.1)])
    expect(fakes.last().sent.map(({ seq }) => seq)).toEqual([1, 2, 3, 4])
    expect(log.withMessage('plugin machine readings started')).toHaveLength(1)
  })

  it('has the latest readings in its snapshot, oldest first and at most 60, and an empty list before any', () => {
    showReady('gauge')
    expect(snapshot()?.machine).toEqual([])

    for (let t = 1; t <= 70; t += 1) monitor.readings.push(reading(t))
    fakes.last().post({ type: 'ready' })

    const latest = events()
      .filter((event) => event.type === PluginEventType.Snapshot)
      .at(-1)
    expect(latest).toMatchObject({ type: PluginEventType.Snapshot })
    const history = latest?.type === PluginEventType.Snapshot ? latest.machine : undefined
    expect(history).toHaveLength(60)
    expect(history?.[0]?.t).toBe(11)
    expect(history?.at(-1)?.t).toBe(70)
  })

  it('stops getting readings while it is hidden, and gets them again once it is shown', () => {
    showReady('gauge')
    views.place('gauge', null)
    expect(monitor.listeners.size).toBe(0)
    monitor.push(reading(1))

    views.place('gauge', bounds)
    expect(monitor.listeners.size).toBe(1)
    monitor.push(reading(2))

    expect(readings().map(({ t }) => t)).toEqual([2])
    expect(log.withMessage('plugin machine readings stopped')).toHaveLength(1)
  })

  it('subscribes once however often it says ready or is moved', () => {
    showReady('gauge')
    fakes.last().post({ type: 'ready' })
    views.place('gauge', { ...bounds, width: 400 })

    expect(monitor.subscriptions).toBe(1)
    monitor.push(reading(1))
    expect(readings()).toHaveLength(1)
  })

  it('stops the readings when it is turned off, its page crashes, another plugin is shown, or the app quits', () => {
    showReady('gauge')
    views.update([plugin('gauge', { enabled: false })])
    expect(monitor.listeners.size).toBe(0)

    views.update([plugin('gauge'), plugin('other', { asks: false })])
    showReady('gauge')
    fakes.last().crash()
    expect(monitor.listeners.size).toBe(0)

    showReady('gauge')
    views.place('other', bounds)
    expect(monitor.listeners.size).toBe(0)

    showReady('gauge')
    views.close()
    expect(monitor.listeners.size).toBe(0)
  })

  it('stops the readings at once when the capability is turned off, and starts them when it is back on', () => {
    showReady('gauge')
    views.update([plugin('gauge', { granted: false })])
    expect(monitor.listeners.size).toBe(0)
    monitor.push(reading(1))

    views.update([plugin('gauge')])
    expect(monitor.listeners.size).toBe(1)
    monitor.push(reading(2))
    expect(readings().map(({ t }) => t)).toEqual([2])
  })

  it('starts over without the readings when it is reloaded, until its new page says ready', () => {
    showReady('gauge')
    views.reload(['gauge'])
    expect(monitor.listeners.size).toBe(0)

    fakes.last().post({ type: 'ready' })
    expect(monitor.listeners.size).toBe(1)
    expect(snapshot()?.machine).toEqual([])
  })

  it('gets no readings when Glade has no machine to read', () => {
    views = create(null)
    views.update([plugin('gauge')])
    showReady('gauge')

    expect(snapshot()).toEqual(SNAPSHOT)
    expect(readings()).toEqual([])
  })
})

describe('a plugin without the machine capability on', () => {
  it.each([
    ['asks for it but has it off', plugin('gauge', { granted: false })],
    ["doesn't ask for it", plugin('gauge', { asks: false })],
  ])('gets nothing new when it %s: no machine in its snapshot, no readings, and no sampling', (_name, off) => {
    views.update([off])
    showReady('gauge')
    monitor.push(reading(1))

    expect(snapshot()).toEqual(SNAPSHOT)
    expect(Object.keys(snapshot() ?? {})).not.toContain('machine')
    expect(readings()).toEqual([])
    expect(monitor.subscriptions).toBe(0)
  })
})
