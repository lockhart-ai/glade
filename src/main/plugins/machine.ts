/**
 * The Mac's load, for plugins with the `machine` capability on (`docs/plugin-api.md`, "Capabilities"). The monitor
 * samples only while someone listens: the shown plugin's view subscribes while it's showing, has said `ready` and has
 * the capability on, and unsubscribes the moment any of that stops (`./views`). Every ~2 s it reads the CPU (all of it,
 * and Claude Code's share) and the GPU, and takes the latest of Docker's containers, which are read alongside, since
 * `docker stats` alone takes about as long as the interval. It keeps the latest readings for a snapshot.
 *
 * What it reads goes through `MachineSamplers`, so tests hand it fakes: the real ones (`./machine-samplers`) run `ps`,
 * `ioreg` and `docker`.
 */
import { MAX_PLUGIN_MACHINE_HISTORY, type PluginContainer, type PluginMachineReading } from '../../shared/plugin-api'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import type { Unsubscribe } from './feed'

/** How often the monitor reads the machine while it's sampling. */
export const MACHINE_SAMPLE_INTERVAL_MS = 2_000

/** CPU in use now, in cores. */
export interface CpuLoad {
  /** By every process. */
  readonly total: number
  /** By Claude Code's processes and their children. */
  readonly claude: number
}

/** Where the monitor's readings come from: `ps`, `ioreg` and `docker` in the app, fakes in tests. */
export interface MachineSamplers {
  /** The Mac's logical CPU cores. */
  cpuCount(): number
  /** The CPU in use; rejects when it can't be read. */
  cpu(): Promise<CpuLoad>
  /** The GPU's utilisation, in percent; null when it can't be read. */
  gpu(): Promise<number | null>
  /** The running containers; empty when Docker isn't installed or isn't running. */
  docker(): Promise<readonly PluginContainer[]>
}

/** Hears each reading as it's taken. */
export type MachineListener = (reading: PluginMachineReading) => void

export interface MachineMonitor {
  /** Hears each reading from now on. Sampling runs while anyone listens, starting with the first. */
  subscribe(listener: MachineListener): Unsubscribe
  /** The latest readings, oldest first, up to `MAX_PLUGIN_MACHINE_HISTORY`: kept across pauses in sampling. */
  history(): readonly PluginMachineReading[]
  /** Whether it's sampling now. */
  sampling(): boolean
  /** Stops sampling and forgets every listener: the app is quitting. */
  close(): void
}

export interface MachineMonitorOptions {
  readonly samplers: MachineSamplers
  readonly intervalMs?: number
  readonly historyLength?: number
  readonly now?: () => number
  readonly log?: Logger
}

/** Cores (or a sum of percentages, over 100), to two decimal places. */
export function roundLoad(value: number): number {
  return Math.round(value * 100) / 100
}

export function createMachineMonitor({
  samplers,
  intervalMs = MACHINE_SAMPLE_INTERVAL_MS,
  historyLength = MAX_PLUGIN_MACHINE_HISTORY,
  now = Date.now,
  log = SILENT_LOGGER,
}: MachineMonitorOptions): MachineMonitor {
  const listeners = new Set<MachineListener>()
  const readings: PluginMachineReading[] = []
  /** Counts each start and stop: a sample that finishes after the run it belongs to has ended is dropped. */
  let run = 0
  let running = false
  let timer: ReturnType<typeof setTimeout> | null = null
  /** The latest containers this run, which each reading takes; empty until Docker first answers. */
  let containers: readonly PluginContainer[] = []
  /** Whether a `docker stats` is still going: another isn't started until it's done. */
  let dockerBusy = false
  /** Whether the CPU couldn't be read last time, so the log says so once, not every 2 s. */
  let failing = false

  const readDocker = (current: number): void => {
    if (dockerBusy) return
    dockerBusy = true
    void samplers
      .docker()
      .catch((error: unknown) => {
        log.debug("docker's containers can't be read", { error })
        return []
      })
      .then((found) => {
        dockerBusy = false
        if (current === run) containers = found
      })
  }

  const sample = async (current: number): Promise<void> => {
    readDocker(current)
    const [cpu, gpu] = await Promise.all([
      samplers.cpu().catch((error: unknown) => {
        if (!failing) log.warn("the CPU can't be read", { error })
        return null
      }),
      samplers.gpu().catch(() => null),
    ])
    if (current !== run) return
    failing = cpu === null
    if (cpu !== null) {
      const reading: PluginMachineReading = {
        t: now(),
        cpuCount: samplers.cpuCount(),
        total: roundLoad(cpu.total),
        claude: roundLoad(cpu.claude),
        docker: roundLoad(containers.reduce((sum, container) => sum + container.cpu, 0) / 100),
        gpu,
        containers,
      }
      readings.push(reading)
      if (readings.length > historyLength) readings.splice(0, readings.length - historyLength)
      for (const listener of listeners) listener(reading)
    }
    timer = setTimeout(() => void sample(current), intervalMs)
  }

  const start = (): void => {
    run += 1
    running = true
    log.info('machine sampling started')
    void sample(run)
  }

  const stop = (): void => {
    run += 1
    running = false
    if (timer !== null) clearTimeout(timer)
    timer = null
    containers = []
    failing = false
    log.info('machine sampling stopped')
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      if (!running) start()
      return () => {
        if (!listeners.delete(listener)) return
        if (listeners.size === 0) stop()
      }
    },
    history: () => [...readings],
    sampling: () => running,
    close() {
      listeners.clear()
      if (running) stop()
    },
  }
}
