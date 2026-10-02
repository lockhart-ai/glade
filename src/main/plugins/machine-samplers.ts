/**
 * The real `MachineSamplers` (`./machine`), as Nekomata's `fleet_dashboard.py` reads the same numbers:
 *
 * - **CPU:** `ps -Ao pid=,ppid=,pcpu=,args=`. Every process's `%CPU` summed is the total; Claude's share is every
 *   `claude` process (its command's first word, as a path or not, is `claude`) and everything under it, each counted
 *   once. A process's command is read here only to tell whether it's Claude's, and never leaves this file.
 * - **GPU:** `ioreg -r -d 1 -w0 -c IOAccelerator`'s `"Device Utilization %"`, the highest of the GPUs. No elevated
 *   rights needed; null when there's none to read.
 * - **Docker:** `docker stats --no-stream`: each running container's name, `CPUPerc` and the used half of `MemUsage`.
 *   It runs in the login shell's environment, so its PATH finds `docker` as your terminal would. It never starts
 *   Docker: with Docker missing or not running, it fails, and there are no containers.
 *
 * Each runs with a timeout, and one that fails reads as nothing (or rejects, for the CPU), never as an error shown.
 */
import { execFile } from 'node:child_process'
import { availableParallelism } from 'node:os'
import type { PluginContainer } from '../../shared/plugin-api'
import type { Environment } from '../login-env'
import { cutText } from './mapping'
import type { CpuLoad, MachineSamplers } from './machine'

/** How long `ps` and `ioreg` get, each time. */
const QUICK_TIMEOUT_MS = 5_000
/** How long `docker stats` gets: it takes a couple of seconds by itself, and longer while Docker is busy. */
const DOCKER_TIMEOUT_MS = 15_000
/** The most a command may print before it's cut off: far more than `ps` prints on a busy Mac. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024

/** A command to run, without a shell. */
export interface MachineCommand {
  readonly file: string
  readonly args: readonly string[]
}

export const PS_COMMAND: MachineCommand = { file: '/bin/ps', args: ['-Ao', 'pid=,ppid=,pcpu=,args='] }
export const GPU_COMMAND: MachineCommand = {
  file: '/usr/sbin/ioreg',
  args: ['-r', '-d', '1', '-w0', '-c', 'IOAccelerator'],
}
export const DOCKER_COMMAND: MachineCommand = {
  file: 'docker',
  args: ['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'],
}

/** `ps` and `ioreg` run with this environment: the C locale, so `%CPU` has a `.` for its decimal point. */
const PLAIN_ENV: Environment = { LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }

export interface RunOptions {
  readonly timeoutMs: number
  readonly env: Environment
}

/** Runs a command and answers with what it printed, or null when it couldn't run, failed or timed out. */
export type RunCommand = (command: MachineCommand, options: RunOptions) => Promise<string | null>

/** Runs a command with `execFile`: no shell, a timeout, and its output capped. */
export const runCommand: RunCommand = (command, { timeoutMs, env }) =>
  new Promise((resolve) => {
    execFile(
      command.file,
      [...command.args],
      { env, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
      (error, stdout) => {
        resolve(error === null ? stdout : null)
      },
    )
  })

/** One line of `ps`. */
export interface ProcessRow {
  readonly pid: number
  readonly ppid: number
  /** Its `%CPU`: 100 is one core. */
  readonly cpu: number
  /** Its command line. */
  readonly command: string
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(.*)$/

/** `ps -Ao pid=,ppid=,pcpu=,args=`'s output, a row per process; lines that don't parse are skipped. */
export function parseProcesses(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of stdout.split('\n')) {
    const match = PS_LINE.exec(line)
    if (match === null) continue
    const [, pid = '', ppid = '', cpu = '', command = ''] = match
    rows.push({ pid: Number(pid), ppid: Number(ppid), cpu: Number(cpu), command })
  }
  return rows
}

/** Whether a command line is Claude Code's: its first word's last path part is `claude`. */
export function isClaudeCommand(command: string): boolean {
  const first = command.trim().split(/\s+/)[0] ?? ''
  return first.split('/').at(-1) === 'claude'
}

/** The CPU in use, in cores: every process's, and Claude Code's processes' and their descendants', each once. */
export function cpuLoad(rows: readonly ProcessRow[]): CpuLoad {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  /** Whether each process is Claude's or under one, by pid, as found. */
  const claudes = new Map<number, boolean>()
  const isUnderClaude = (row: ProcessRow): boolean => {
    const path: number[] = []
    let current: ProcessRow | undefined = row
    let found = false
    while (current !== undefined) {
      const known = claudes.get(current.pid)
      if (known !== undefined) {
        found = known
        break
      }
      // A parent loop (pid 0 is its own parent) ends the walk: nothing above it is Claude's.
      if (path.includes(current.pid)) break
      path.push(current.pid)
      if (isClaudeCommand(current.command)) {
        found = true
        break
      }
      current = byPid.get(current.ppid)
    }
    for (const pid of path) claudes.set(pid, found)
    return found
  }
  let total = 0
  let claude = 0
  for (const row of rows) {
    total += row.cpu
    if (isUnderClaude(row)) claude += row.cpu
  }
  return { total: total / 100, claude: claude / 100 }
}

const GPU_UTILIZATION = /"Device Utilization %"\s*=\s*(\d+)/g

/** The busiest GPU's utilisation in `ioreg`'s output, in percent (at most 100); null when it has none. */
export function parseGpu(stdout: string): number | null {
  const values = [...stdout.matchAll(GPU_UTILIZATION)].map((match) => Number(match[1]))
  return values.length === 0 ? null : Math.min(100, Math.max(...values))
}

/** The bytes in each of `docker stats`' units: binary (`MiB`) and decimal (`MB`, `kB`) alike. */
const MEMORY_UNITS: Readonly<Record<string, number>> = {
  b: 1,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  tb: 1000 ** 4,
}

/** The used half of `docker stats`' `MemUsage` (`180MiB / 2GiB`), in whole bytes; 0 when it can't be read. */
export function parseMemory(usage: string): number {
  const [, amount = '', unitName = ''] = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)/i.exec(usage) ?? []
  const unit = MEMORY_UNITS[unitName.toLowerCase()]
  return unit === undefined ? 0 : Math.round(Number(amount) * unit)
}

/** `docker stats --no-stream`'s output, in `DOCKER_COMMAND`'s format: a container per line, busiest first. */
export function parseDockerStats(stdout: string): PluginContainer[] {
  const containers: PluginContainer[] = []
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t')
    if (parts.length !== 3) continue
    const [name = '', cpu = '', memory = ''] = parts
    if (name.trim() === '') continue
    const percent = Number.parseFloat(cpu)
    containers.push({
      name: cutText(name.trim()),
      cpu: Number.isFinite(percent) && percent > 0 ? percent : 0,
      memory: parseMemory(memory),
    })
  }
  return containers.sort((a, b) => b.cpu - a.cpu)
}

export interface MachineSamplerOptions {
  /** The login shell's environment, which `docker` runs in so its PATH finds it. */
  readonly env: () => Promise<Environment>
  readonly run?: RunCommand
  readonly cpuCount?: () => number
}

/** The samplers the app reads the machine with. */
export function createMachineSamplers({
  env,
  run = runCommand,
  cpuCount = availableParallelism,
}: MachineSamplerOptions): MachineSamplers {
  return {
    cpuCount,
    async cpu() {
      const stdout = await run(PS_COMMAND, { timeoutMs: QUICK_TIMEOUT_MS, env: PLAIN_ENV })
      const rows = stdout === null ? [] : parseProcesses(stdout)
      if (rows.length === 0) throw new Error("ps didn't list any processes")
      return cpuLoad(rows)
    },
    async gpu() {
      const stdout = await run(GPU_COMMAND, { timeoutMs: QUICK_TIMEOUT_MS, env: PLAIN_ENV })
      return stdout === null ? null : parseGpu(stdout)
    },
    async docker() {
      const stdout = await run(DOCKER_COMMAND, { timeoutMs: DOCKER_TIMEOUT_MS, env: await env() })
      return stdout === null ? [] : parseDockerStats(stdout)
    },
  }
}
