/**
 * A machine that's always busy the same way, for the test modes (e2e and captures) and unit tests: what a plugin with
 * the `machine` capability is sent there, so it never depends on the Mac it runs on. The containers are made up.
 */
import type { PluginContainer } from '../../shared/plugin-api'
import type { CpuLoad, MachineSamplers } from './machine'

export const FAKE_CPU_COUNT = 10
export const FAKE_CPU: CpuLoad = { total: 7.3, claude: 4.6 }
export const FAKE_GPU = 88
export const FAKE_CONTAINERS: readonly PluginContainer[] = [
  { name: 'acme-api-db-1', cpu: 78, memory: 440_401_920 },
  { name: 'acme-api-web-1', cpu: 46, memory: 188_743_680 },
  { name: 'acme-api-worker-1', cpu: 12, memory: 94_371_840 },
  { name: 'acme-api-cache-1', cpu: 4, memory: 1_181_116_006 },
]

/** Samplers that read `FAKE_CPU`, `FAKE_GPU` and `FAKE_CONTAINERS` on a Mac with `FAKE_CPU_COUNT` cores. */
export function createFakeMachineSamplers(): MachineSamplers {
  return {
    cpuCount: () => FAKE_CPU_COUNT,
    cpu: () => Promise.resolve(FAKE_CPU),
    gpu: () => Promise.resolve(FAKE_GPU),
    docker: () => Promise.resolve(FAKE_CONTAINERS),
  }
}
