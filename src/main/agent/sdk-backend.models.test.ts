// The models a session's SDK offers, with the SDK's `query()` replaced: the backend reports them as each agent process
// starts, and logs a failure to read them.
import { beforeEach, expect, it, vi } from 'vitest'
import { Effort, PermissionMode } from '../../shared/domain'
import { LogLevel, LogScope } from '../logging/logger'
import { createMemoryLog } from '../logging/memory-sink'
import type { AgentSessionOptions } from './backend'
import { createSdkBackend } from './sdk-backend'

const sdk = vi.hoisted(() => {
  const session = {
    initializationResult: vi.fn<() => Promise<{ models: unknown }>>(() =>
      Promise.resolve({ models: [{ value: 'sonnet', displayName: 'Sonnet' }] }),
    ),
    close: vi.fn(),
    [Symbol.asyncIterator]: vi.fn(async function* () {
      yield await Promise.resolve({ type: 'system', subtype: 'init' })
    }),
  }
  return { session, query: vi.fn(() => session) }
})

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }))

const OPTIONS: AgentSessionOptions = {
  cwd: '/code/acme-api',
  model: 'claude-sample-1',
  effort: Effort.High,
  permissionMode: PermissionMode.AllowAll,
  resumeSessionId: null,
  systemPromptAppend: 'You are running inside Glade.',
  mcpServers: {},
}

const ENV = { PATH: '/usr/bin:/bin' }

beforeEach(() => {
  vi.clearAllMocks()
})

it('reports the models the SDK offers, unparsed, once each session’s agent process has started', async () => {
  const onModels = vi.fn()
  const backend = createSdkBackend({ version: '1.2.3', env: Promise.resolve(ENV), onModels })

  backend.start(OPTIONS)
  backend.start(OPTIONS)

  await vi.waitFor(() => {
    expect(onModels).toHaveBeenCalledTimes(2)
  })
  expect(onModels).toHaveBeenCalledWith([{ value: 'sonnet', displayName: 'Sonnet' }])
  expect(sdk.session.initializationResult).toHaveBeenCalledTimes(2)
})

it('waits for the environment, like the agent process', async () => {
  const onModels = vi.fn()
  let resolve: (env: typeof ENV) => void = () => undefined
  createSdkBackend({ version: '1.2.3', env: new Promise((done) => (resolve = done)), onModels }).start(OPTIONS)
  await Promise.resolve()
  expect(sdk.session.initializationResult).not.toHaveBeenCalled()

  resolve(ENV)

  await vi.waitFor(() => {
    expect(onModels).toHaveBeenCalledOnce()
  })
})

it('asks for no models when nothing hears them', async () => {
  createSdkBackend({ version: '1.2.3', env: Promise.resolve(ENV) }).start(OPTIONS)
  await vi.waitFor(() => {
    expect(sdk.query).toHaveBeenCalledOnce()
  })
  await Promise.resolve()

  expect(sdk.session.initializationResult).not.toHaveBeenCalled()
})

it('logs a session whose models it couldn’t read, and the session goes on', async () => {
  sdk.session.initializationResult.mockRejectedValueOnce(new Error('The process exited'))
  const onModels = vi.fn()
  const log = createMemoryLog(LogScope.Agent)
  const session = createSdkBackend({ version: '1.2.3', env: Promise.resolve(ENV), onModels }).start({
    ...OPTIONS,
    log: log.logger,
  })

  await vi.waitFor(() => {
    expect(log.withMessage("couldn't read the models the SDK offers")).toEqual([
      expect.objectContaining({ level: LogLevel.Warn }),
    ])
  })
  expect(onModels).not.toHaveBeenCalled()
  const messages: unknown[] = []
  for await (const message of session.messages) messages.push(message)
  expect(messages).toEqual([{ type: 'system', subtype: 'init' }])
})
