// The machine monitor (#403), on fake samplers and fake timers: no real ps, ioreg or docker.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginContainer, PluginMachineReading } from '../../shared/plugin-api'
import { pluginMachineReadingSchema } from '../../shared/plugin-api-schema'
import { createMemoryLog, type MemoryLog } from '../logging/memory-sink'
import {
  createMachineMonitor,
  MACHINE_SAMPLE_INTERVAL_MS,
  roundLoad,
  type CpuLoad,
  type MachineMonitor,
  type MachineSamplers,
} from './machine'
import { createFakeMachineSamplers, FAKE_CONTAINERS, FAKE_CPU, FAKE_CPU_COUNT, FAKE_GPU } from './machine-fake'

/** Samplers a test controls: what each answers, and how many times each was asked. */
interface ScriptedSamplers extends MachineSamplers {
  cpuLoad: CpuLoad | Error
  gpuLoad: number | null | Error
  containers: readonly PluginContainer[] | Error
  /** When set, `docker()` waits for the test to call it before answering. */
  holdDocker: boolean
  releaseDocker: (() => void) | null
  calls: { cpu: number; gpu: number; docker: number }
}

function scripted(): ScriptedSamplers {
  const samplers: ScriptedSamplers = {
    cpuLoad: { total: 3.456, claude: 1.234 },
    gpuLoad: 42,
    containers: [],
    holdDocker: false,
    releaseDocker: null,
    calls: { cpu: 0, gpu: 0, docker: 0 },
    cpuCount: () => 8,
    cpu() {
      samplers.calls.cpu += 1
      const load = samplers.cpuLoad
      return load instanceof Error ? Promise.reject(load) : Promise.resolve(load)
    },
    gpu() {
      samplers.calls.gpu += 1
      const load = samplers.gpuLoad
      return load instanceof Error ? Promise.reject(load) : Promise.resolve(load)
    },
    docker() {
      samplers.calls.docker += 1
      const answer = (): Promise<readonly PluginContainer[]> => {
        const found = samplers.containers
        return found instanceof Error ? Promise.reject(found) : Promise.resolve(found)
      }
      if (!samplers.holdDocker) return answer()
      return new Promise((resolve, reject) => {
        samplers.releaseDocker = () => {
          answer().then(resolve, reject)
        }
      })
    },
  }
  return samplers
}

let samplers: ScriptedSamplers
let monitor: MachineMonitor
let log: MemoryLog
let time: number

beforeEach(() => {
  vi.useFakeTimers()
  samplers = scripted()
  log = createMemoryLog()
  time = 1_000
  monitor = createMachineMonitor({ samplers, now: () => time, log: log.logger })
})

afterEach(() => {
  monitor.close()
  vi.useRealTimers()
})

/** Lets the samplers' promises settle, without moving the clock. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

/** Moves the clock on by one interval, and lets that sample finish. */
async function tick(): Promise<void> {
  time += MACHINE_SAMPLE_INTERVAL_MS
  await vi.advanceTimersByTimeAsync(MACHINE_SAMPLE_INTERVAL_MS)
}

describe('sampling', () => {
  it("doesn't sample until someone listens", async () => {
    await vi.advanceTimersByTimeAsync(60_000)

    expect(samplers.calls).toEqual({ cpu: 0, gpu: 0, docker: 0 })
    expect(monitor.sampling()).toBe(false)
    expect(monitor.history()).toEqual([])
  })

  it('reads the machine at once when the first listener comes, then every 2 s', async () => {
    const heard: PluginMachineReading[] = []
    monitor.subscribe((reading) => heard.push(reading))
    expect(monitor.sampling()).toBe(true)
    await settle()
    expect(heard).toHaveLength(1)

    await tick()
    await tick()

    expect(heard.map(({ t }) => t)).toEqual([1_000, 3_000, 5_000])
    expect(samplers.calls.cpu).toBe(3)
    expect(log.withMessage('machine sampling started')).toHaveLength(1)
  })

  it('stops when the last listener goes, and not before', async () => {
    const first = monitor.subscribe(vi.fn())
    const second = monitor.subscribe(vi.fn())
    await settle()

    first()
    expect(monitor.sampling()).toBe(true)
    await tick()
    expect(samplers.calls.cpu).toBe(2)

    second()
    expect(monitor.sampling()).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(samplers.calls.cpu).toBe(2)
    expect(log.withMessage('machine sampling stopped')).toHaveLength(1)
  })

  it('ignores a listener unsubscribed twice', async () => {
    const off = monitor.subscribe(vi.fn())
    monitor.subscribe(vi.fn())
    off()
    off()
    await settle()

    expect(monitor.sampling()).toBe(true)
  })

  it('drops a sample that finishes after sampling stopped, and starts afresh when someone listens again', async () => {
    const listener = vi.fn()
    const off = monitor.subscribe(listener)
    off()
    await settle()
    expect(listener).not.toHaveBeenCalled()
    expect(monitor.history()).toEqual([])

    monitor.subscribe(listener)
    await settle()
    expect(listener).toHaveBeenCalledTimes(1)
    // One timer: the stopped run scheduled none.
    await tick()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('stops for good on close, forgetting every listener', async () => {
    const listener = vi.fn()
    monitor.subscribe(listener)
    await settle()
    monitor.close()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(monitor.sampling()).toBe(false)
    monitor.close()
  })
})

describe('a reading', () => {
  it("has the time, the core count, the CPU to two places, the GPU and Docker's containers", async () => {
    samplers.containers = [
      { name: 'acme-api-db-1', cpu: 78.5, memory: 1 },
      { name: 'acme-api-web-1', cpu: 46.25, memory: 2 },
    ]
    const heard: PluginMachineReading[] = []
    monitor.subscribe((reading) => heard.push(reading))
    await settle()
    await tick()

    const latest = heard.at(-1)
    expect(latest).toEqual({
      t: 3_000,
      cpuCount: 8,
      total: 3.46,
      claude: 1.23,
      docker: 1.25,
      gpu: 42,
      containers: samplers.containers,
    })
    expect(pluginMachineReadingSchema.parse(latest)).toEqual(latest)
  })

  it('has no containers until Docker first answers, and keeps the last ones while it is still reading', async () => {
    samplers.holdDocker = true
    samplers.containers = FAKE_CONTAINERS
    const heard: PluginMachineReading[] = []
    monitor.subscribe((reading) => heard.push(reading))
    await settle()
    expect(heard[0]?.containers).toEqual([])

    // Still reading: no second docker stats is started on top of it.
    await tick()
    expect(samplers.calls.docker).toBe(1)
    samplers.releaseDocker?.()
    await settle()
    await tick()

    expect(heard.at(-1)?.containers).toEqual(FAKE_CONTAINERS)
    expect(heard.at(-1)?.docker).toBe(1.4)
    expect(samplers.calls.docker).toBe(2)
  })

  it('reads no containers when Docker fails, and a null GPU when it fails', async () => {
    samplers.containers = new Error('Cannot connect to the Docker daemon')
    samplers.gpuLoad = new Error('ioreg went away')
    const heard: PluginMachineReading[] = []
    monitor.subscribe((reading) => heard.push(reading))
    await settle()
    await tick()

    expect(heard.at(-1)).toMatchObject({ gpu: null, containers: [], docker: 0 })
  })

  it("drops Docker's answer when sampling stopped while it was reading", async () => {
    samplers.holdDocker = true
    samplers.containers = FAKE_CONTAINERS
    const off = monitor.subscribe(vi.fn())
    await settle()
    off()
    samplers.releaseDocker?.()
    await settle()

    // The next run's own docker stats is still reading, so its first reading has only what that run found: none.
    const heard: PluginMachineReading[] = []
    monitor.subscribe((reading) => heard.push(reading))
    await settle()
    expect(samplers.calls.docker).toBe(2)
    expect(heard[0]?.containers).toEqual([])
  })

  it("skips a reading when the CPU can't be read, saying so once, and carries on", async () => {
    samplers.cpuLoad = new Error('ps timed out')
    const heard: PluginMachineReading[] = []
    monitor.subscribe((reading) => heard.push(reading))
    await settle()
    await tick()
    expect(heard).toEqual([])
    expect(log.withMessage("the CPU can't be read")).toHaveLength(1)

    samplers.cpuLoad = { total: 1, claude: 0 }
    await tick()
    expect(heard).toHaveLength(1)
  })
})

describe('history', () => {
  it('keeps the latest 60, oldest first, across pauses in sampling', async () => {
    const off = monitor.subscribe(vi.fn())
    await settle()
    for (let i = 0; i < 64; i += 1) await tick()
    off()

    const history = monitor.history()
    expect(history).toHaveLength(60)
    expect(history[0]?.t).toBe(1_000 + 5 * MACHINE_SAMPLE_INTERVAL_MS)
    expect(history.at(-1)?.t).toBe(time)
  })

  it('keeps as many as it is told to', async () => {
    monitor = createMachineMonitor({ samplers, historyLength: 2, now: () => time })
    monitor.subscribe(vi.fn())
    await settle()
    await tick()
    await tick()

    expect(monitor.history().map(({ t }) => t)).toEqual([3_000, 5_000])
  })

  it('is a copy', async () => {
    monitor.subscribe(vi.fn())
    await settle()
    const history = monitor.history() as PluginMachineReading[]
    history.length = 0

    expect(monitor.history()).toHaveLength(1)
  })
})

describe('roundLoad', () => {
  it('rounds to two decimal places', () => {
    expect(roundLoad(3.14159)).toBe(3.14)
    expect(roundLoad(0.005)).toBe(0.01)
    expect(roundLoad(0)).toBe(0)
  })
})

describe('the fake machine', () => {
  it('is always busy the same way, as the test modes show it', async () => {
    monitor = createMachineMonitor({ samplers: createFakeMachineSamplers(), now: () => time })
    const heard: PluginMachineReading[] = []
    monitor.subscribe((reading) => heard.push(reading))
    await settle()
    await tick()

    expect(heard.at(-1)).toEqual({
      t: 3_000,
      cpuCount: FAKE_CPU_COUNT,
      total: FAKE_CPU.total,
      claude: FAKE_CPU.claude,
      docker: 1.4,
      gpu: FAKE_GPU,
      containers: FAKE_CONTAINERS,
    })
  })
})
