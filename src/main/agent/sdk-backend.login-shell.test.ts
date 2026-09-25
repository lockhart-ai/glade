// Regression test for #161: opened from Finder or the Dock, Glade has launchd's bare PATH, and its agent sessions ran
// with it, so Homebrew's, nvm's, pnpm's and ~/.local/bin's tools were missing. Starts from that environment with a fake
// login shell (a `/bin/sh` script that adds to PATH, as a profile would), and checks the environment the SDK spawns
// Claude Code with: the one given in `env`, or, when there's none, Glade's own (the SDK's default).
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Effort, PermissionMode } from '../../shared/domain'
import { resolveLoginEnv } from '../login-env'
import type { AgentSessionOptions } from './backend'
import { createSdkBackend } from './sdk-backend'
import { createMemoryLog } from '../logging/memory-sink'

const sdk = vi.hoisted(() => ({
  query: vi.fn((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const session = (async function* () {
      // One reply per message pushed, as a session answering each turn would.
      for await (const message of params.prompt) yield { type: 'result', uuid: message.uuid }
    })()
    return Object.assign(session, { close: vi.fn() })
  }),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }))

/** launchd's PATH: what an app opened from Finder or the Dock starts with. */
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

const OPTIONS: AgentSessionOptions = {
  cwd: '/code/acme-api',
  model: 'claude-sample-1',
  effort: Effort.High,
  permissionMode: PermissionMode.AllowAll,
  resumeSessionId: null,
  systemPromptAppend: 'You are running inside Glade.',
  mcpServers: {},
}

const log = { info: vi.fn(), warn: vi.fn() }
let folder: string

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'glade-login-shell-'))
  sdk.query.mockClear()
  // Glade opened from Finder: launchd's environment.
  vi.stubEnv('PATH', LAUNCHD_PATH)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(folder, { recursive: true, force: true })
})

/** Makes `$SHELL` a fake login shell running `profile` first. */
function useLoginShell(profile: string): void {
  const shell = join(folder, 'login-shell')
  writeFileSync(shell, `#!/bin/sh\n${profile}\nexec /bin/sh -c "$2"\n`)
  chmodSync(shell, 0o755)
  vi.stubEnv('SHELL', shell)
}

/** Starts a session as the app does: in the login shell's environment, read from Glade's own. */
function startSession(): ReturnType<ReturnType<typeof createSdkBackend>['start']> {
  const env = resolveLoginEnv({ shell: process.env.SHELL, base: process.env, cwd: folder, log }).then(({ env }) => env)
  return createSdkBackend({ env, log: createMemoryLog().logger }).start(OPTIONS)
}

/** The environment the SDK spawned Claude Code with: the one it was given, or Glade's own when it wasn't given one. */
async function spawnEnv(): Promise<NodeJS.ProcessEnv> {
  await vi.waitFor(() => {
    expect(sdk.query).toHaveBeenCalledOnce()
  })
  return sdk.query.mock.calls[0]?.[0].options.env ?? { ...process.env }
}

it("spawns the agent with the login shell's PATH when Glade starts with launchd's bare one", async () => {
  useLoginShell('export PATH="/opt/sample/bin:$HOME/.local/bin:$PATH"')

  startSession()

  expect((await spawnEnv()).PATH).toBe(`/opt/sample/bin:${String(process.env.HOME)}/.local/bin:${LAUNCHD_PATH}`)
})

it("still starts the agent, and sends, on Glade's own environment when the login shell is broken", async () => {
  vi.stubEnv('SHELL', join(folder, 'no-such-shell'))

  const session = startSession()
  session.send('Hi', 'uuid-1')

  expect((await spawnEnv()).PATH).toBe(LAUNCHD_PATH)
  const iterator = session.messages[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toEqual({ type: 'result', uuid: 'uuid-1' })
  expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^Couldn't read the login shell's environment/))
  session.close()
})
