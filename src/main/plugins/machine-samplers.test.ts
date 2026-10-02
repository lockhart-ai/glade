// Reading ps, ioreg and docker's output (#403), from made-up output through a fake `run`: no real command runs here
// (`machine-samplers.integration.test.ts` runs the real ones once).
import { describe, expect, it, vi } from 'vitest'
import { MAX_PLUGIN_TEXT } from '../../shared/plugin-api'
import {
  cpuLoad,
  createMachineSamplers,
  DOCKER_COMMAND,
  GPU_COMMAND,
  isClaudeCommand,
  parseDockerStats,
  parseGpu,
  parseMemory,
  parseProcesses,
  PS_COMMAND,
  type MachineCommand,
  type ProcessRow,
  type RunCommand,
  type RunOptions,
} from './machine-samplers'

const CLAUDE = '/Applications/Glade.app/Contents/Resources/app.asar.unpacked/node_modules/claude-sdk/claude'

/** `ps -Ao pid=,ppid=,pcpu=,args=` on a made-up Mac. */
const PS = [
  '    1     0   1.8 /sbin/launchd',
  '  400     1  50.0 /Applications/Glade.app/Contents/MacOS/Glade',
  `  500   400  14.5 ${CLAUDE} --output-format stream-json --verbose`,
  '  510   500  80.0 /bin/zsh -c npm test',
  '  511   510 120.0 node vitest run',
  '  600     1   0.4 /Applications/Claude.app/Contents/MacOS/Claude',
  '  700     1   2.0 claude',
  '  701   700   3.0 /bin/zsh -c make',
  '  702   701   5.0 claude --print hi',
  '  800     1  25.0 /Applications/Utilities/Some App.app/Contents/MacOS/Some App --flag',
].join('\n')

function row(pid: number, ppid: number, cpu: number, command: string): ProcessRow {
  return { pid, ppid, cpu, command }
}

describe('parseProcesses', () => {
  it('reads each process: pid, parent, %CPU and command line, spaces and all', () => {
    const rows = parseProcesses(PS)

    expect(rows).toHaveLength(10)
    expect(rows[0]).toEqual(row(1, 0, 1.8, '/sbin/launchd'))
    expect(rows.at(-1)).toEqual(row(800, 1, 25, '/Applications/Utilities/Some App.app/Contents/MacOS/Some App --flag'))
  })

  it("skips lines that aren't a process: blank, a header, or a decimal comma", () => {
    expect(parseProcesses('')).toEqual([])
    expect(parseProcesses('  PID  PPID  %CPU ARGS\n\n  12 1 0,5 x\n  13 1 7 sleep 5\n')).toEqual([
      row(13, 1, 7, 'sleep 5'),
    ])
  })
})

describe('isClaudeCommand', () => {
  it.each([
    ['claude', true],
    ['claude --print hi', true],
    [`${CLAUDE} --output-format stream-json`, true],
    ['/Users/sample/.local/bin/claude', true],
    ['  claude', true],
    ['/Applications/Claude.app/Contents/MacOS/Claude', false],
    ['node /opt/homebrew/bin/claude-code', false],
    ['vim notes/claude', false],
    ['claudette', false],
    ['', false],
  ])('%s → %s', (command, expected) => {
    expect(isClaudeCommand(command)).toBe(expected)
  })
})

describe('cpuLoad', () => {
  it("sums every process for the total, and Claude's processes and everything under them for its share", () => {
    expect(cpuLoad(parseProcesses(PS))).toEqual({
      total: (1.8 + 50 + 14.5 + 80 + 120 + 0.4 + 2 + 3 + 5 + 25) / 100,
      // Glade's task (500) and its shell and tests, and the terminal's claude (700) and everything under it, once.
      claude: (14.5 + 80 + 120 + 2 + 3 + 5) / 100,
    })
  })

  it("counts a claude under another claude's tree once, whichever order ps lists them in", () => {
    const rows = [row(3, 2, 10, 'claude --print'), row(2, 1, 20, 'bash'), row(1, 0, 30, 'claude')]

    expect(cpuLoad(rows)).toEqual({ total: 0.6, claude: 0.6 })
    expect(cpuLoad([...rows].reverse())).toEqual({ total: 0.6, claude: 0.6 })
  })

  it('is nothing for nothing, and no Claude share without a claude', () => {
    expect(cpuLoad([])).toEqual({ total: 0, claude: 0 })
    expect(cpuLoad([row(1, 0, 100, '/sbin/launchd')])).toEqual({ total: 1, claude: 0 })
  })

  it('ends at a parent loop, or a parent ps no longer lists', () => {
    // pid 0 is its own parent; 9 and 8 are each other's (a pid reused mid-listing); 5's parent has exited.
    const rows = [row(0, 0, 1, 'kernel_task'), row(9, 8, 2, 'a'), row(8, 9, 3, 'b'), row(5, 4, 4, 'c')]

    expect(cpuLoad(rows)).toEqual({ total: 0.1, claude: 0 })
  })
})

describe('parseGpu', () => {
  it('reads the busiest GPU\'s "Device Utilization %"', () => {
    const ioreg = [
      '+-o AGXAcceleratorG15X  <class AGXAcceleratorG15X>',
      '    "PerformanceStatistics" = {"In use system memory"=123,"Device Utilization %"=17,"Renderer Utilization %"=9}',
      '+-o Another  <class IOAccelerator>',
      '    "PerformanceStatistics" = {"Device Utilization %"=64}',
    ].join('\n')

    expect(parseGpu(ioreg)).toBe(64)
  })

  it('is null without one, and never more than 100', () => {
    expect(parseGpu('')).toBeNull()
    expect(parseGpu('"Renderer Utilization %"=12')).toBeNull()
    expect(parseGpu('"Device Utilization %"=140')).toBe(100)
  })
})

describe('parseMemory', () => {
  it.each([
    ['180MiB / 2GiB', 180 * 1024 ** 2],
    ['1.1GiB / 8GiB', Math.round(1.1 * 1024 ** 3)],
    ['512KiB / 1GiB', 512 * 1024],
    ['0B / 0B', 0],
    ['12.5MB / 1GB', 12_500_000],
    ['3kB / 1GB', 3_000],
    ['2TiB / 4TiB', 2 * 1024 ** 4],
    ['1TB / 1TB', 1e12],
    ['1.5GB / 1TB', 1.5e9],
    ['7b / 1b', 7],
  ])('%s is %d bytes', (usage, bytes) => {
    expect(parseMemory(usage)).toBe(bytes)
  })

  it.each([['--'], [''], ['12 parsecs'], ['MiB / GiB']])("is 0 for %j, which it can't read", (usage) => {
    expect(parseMemory(usage)).toBe(0)
  })
})

describe('parseDockerStats', () => {
  it("reads each container's name, CPU and the memory it uses, busiest first", () => {
    const stats = ['acme-api-web-1\t46.12%\t180MiB / 2GiB', 'acme-api-db-1\t78.00%\t420MiB / 4GiB'].join('\n')

    expect(parseDockerStats(stats)).toEqual([
      { name: 'acme-api-db-1', cpu: 78, memory: 420 * 1024 ** 2 },
      { name: 'acme-api-web-1', cpu: 46.12, memory: 180 * 1024 ** 2 },
    ])
  })

  it('reads a CPU it can\'t make out (Docker\'s "--" while a container starts) as 0, and skips broken lines', () => {
    const stats = [
      'starting-1\t--\t-- / --',
      '',
      'no-tabs here',
      '\t5%\t1MiB / 2MiB',
      'too\tmany\ttabs\there',
      'negative-1\t-3%\t1MiB / 1GiB',
    ].join('\n')

    expect(parseDockerStats(stats)).toEqual([
      { name: 'starting-1', cpu: 0, memory: 0 },
      { name: 'negative-1', cpu: 0, memory: 1024 ** 2 },
    ])
  })

  it('cuts a long name to 200 characters', () => {
    const [container] = parseDockerStats(`${'x'.repeat(300)}\t1%\t1MiB / 1GiB`)

    expect(container?.name).toHaveLength(MAX_PLUGIN_TEXT)
  })
})

describe('createMachineSamplers', () => {
  /** A `run` that answers each command with made-up output, or null for a failure, and records how it was run. */
  function fakeRun(outputs: Partial<Record<string, string | null>>): {
    run: RunCommand
    calls: [MachineCommand, RunOptions][]
  } {
    const calls: [MachineCommand, RunOptions][] = []
    const run: RunCommand = (command, options) => {
      calls.push([command, options])
      return Promise.resolve(outputs[command.file] ?? null)
    }
    return { run, calls }
  }

  const loginEnv = { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: '/Users/sample' }

  it("reads the CPU with ps, in the C locale, without the login shell's environment", async () => {
    const { run, calls } = fakeRun({ [PS_COMMAND.file]: PS })
    const env = vi.fn(() => Promise.resolve(loginEnv))
    const samplers = createMachineSamplers({ env, run, cpuCount: () => 12 })

    expect(await samplers.cpu()).toEqual(cpuLoad(parseProcesses(PS)))
    expect(samplers.cpuCount()).toBe(12)
    expect(calls).toEqual([
      [PS_COMMAND, { timeoutMs: 5_000, env: expect.objectContaining({ LC_ALL: 'C' }) as unknown }],
    ])
    expect(env).not.toHaveBeenCalled()
  })

  it("rejects when ps can't run or lists nothing, so the reading is skipped", async () => {
    await expect(createMachineSamplers({ env: vi.fn(), run: fakeRun({}).run }).cpu()).rejects.toThrow(/ps/)
    const empty = fakeRun({ [PS_COMMAND.file]: '' })
    await expect(createMachineSamplers({ env: vi.fn(), run: empty.run }).cpu()).rejects.toThrow(/ps/)
  })

  it('reads the GPU with ioreg, and null when ioreg fails', async () => {
    const { run, calls } = fakeRun({ [GPU_COMMAND.file]: '"Device Utilization %"=31' })

    expect(await createMachineSamplers({ env: vi.fn(), run }).gpu()).toBe(31)
    expect(calls[0]?.[0]).toBe(GPU_COMMAND)
    expect(await createMachineSamplers({ env: vi.fn(), run: fakeRun({}).run }).gpu()).toBeNull()
  })

  it("reads Docker's containers with docker stats --no-stream in the login shell's environment", async () => {
    const { run, calls } = fakeRun({ docker: 'acme-api-db-1\t12.5%\t1GiB / 2GiB' })

    expect(await createMachineSamplers({ env: () => Promise.resolve(loginEnv), run }).docker()).toEqual([
      { name: 'acme-api-db-1', cpu: 12.5, memory: 1024 ** 3 },
    ])
    expect(calls).toEqual([[DOCKER_COMMAND, { timeoutMs: 15_000, env: loginEnv }]])
    expect(DOCKER_COMMAND.args).toContain('--no-stream')
  })

  it("has no containers when Docker isn't installed or isn't running: the command fails", async () => {
    expect(await createMachineSamplers({ env: () => Promise.resolve({}), run: fakeRun({}).run }).docker()).toEqual([])
  })
})
