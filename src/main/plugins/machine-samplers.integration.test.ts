// The real samplers, run once on this Mac (#403): ps, ioreg and docker as Glade runs them, and a reading the monitor
// makes from them that passes the plugin API's schema. Only on macOS, where CI runs; whatever the Mac's load, Docker
// (installed, running or neither) and GPU, the shape holds.
import { describe, expect, it } from 'vitest'
import { pluginMachineReadingSchema } from '../../shared/plugin-api-schema'
import { definedEnv } from '../login-env'
import { createMachineMonitor, type MachineMonitor } from './machine'
import { createMachineSamplers, runCommand } from './machine-samplers'

const env = (): Promise<Record<string, string>> => Promise.resolve(definedEnv(process.env))

describe.runIf(process.platform === 'darwin')('the real samplers', () => {
  it('read the CPU with ps: every process, and a Claude share no bigger than it', async () => {
    const samplers = createMachineSamplers({ env })
    const cpu = await samplers.cpu()

    expect(cpu.total).toBeGreaterThanOrEqual(0)
    expect(cpu.claude).toBeGreaterThanOrEqual(0)
    expect(cpu.claude).toBeLessThanOrEqual(cpu.total)
    expect(samplers.cpuCount()).toBeGreaterThan(0)
  })

  it('read the GPU with ioreg, or null, without elevated rights', async () => {
    const gpu = await createMachineSamplers({ env }).gpu()

    expect(gpu === null || (gpu >= 0 && gpu <= 100)).toBe(true)
  })

  it("read Docker's containers, or none when it isn't installed or running, within the timeout", async () => {
    const containers = await createMachineSamplers({ env }).docker()

    expect(Array.isArray(containers)).toBe(true)
  }, 20_000)

  it('make a reading the plugin API takes', async () => {
    const monitor: MachineMonitor = createMachineMonitor({ samplers: createMachineSamplers({ env }) })
    const reading = await new Promise((resolve) => {
      const off = monitor.subscribe((first) => {
        off()
        resolve(first)
      })
    })

    expect(pluginMachineReadingSchema.parse(reading)).toEqual(reading)
    monitor.close()
  })

  it("answers null for a command that isn't there, or that fails", async () => {
    expect(await runCommand({ file: '/nonexistent/glade-sampler', args: [] }, { timeoutMs: 1_000, env: {} })).toBe(null)
    expect(await runCommand({ file: '/usr/bin/false', args: [] }, { timeoutMs: 1_000, env: {} })).toBeNull()
    expect(await runCommand({ file: '/bin/echo', args: ['ok'] }, { timeoutMs: 1_000, env: {} })).toBe('ok\n')
  })
})
