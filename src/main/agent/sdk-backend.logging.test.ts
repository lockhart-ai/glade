// What the SDK adapter logs, with the SDK's `query()` replaced: each agent process starting, and what's asked of it.
import { beforeEach, expect, it, vi } from 'vitest'
import { Effort, PermissionMode } from '../../shared/domain'
import { LogLevel, LogScope } from '../logging/logger'
import { createMemoryLog } from '../logging/memory-sink'
import type { AgentSessionOptions } from './backend'
import { createSdkBackend } from './sdk-backend'

const sdk = vi.hoisted(() => {
  const session = {
    interrupt: vi.fn(() => Promise.resolve(undefined)),
    stopTask: vi.fn(() => Promise.resolve(undefined)),
    setModel: vi.fn(() => Promise.resolve(undefined)),
    applyFlagSettings: vi.fn(() => Promise.resolve(undefined)),
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
  resumeSessionId: 'session-1',
  systemPromptAppend: 'You are running inside Glade.',
  mcpServers: {},
}

const ENV = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', ANTHROPIC_API_KEY: 'sk-ant-sample' }

beforeEach(() => {
  vi.clearAllMocks()
})

it('logs the agent process starting, where and on what, in the session’s own log', async () => {
  const backendLog = createMemoryLog(LogScope.Agent)
  const sessionLog = createMemoryLog(LogScope.Agent)
  const session = createSdkBackend({ version: '1.2.3', env: Promise.resolve(ENV), log: backendLog.logger }).start({
    ...OPTIONS,
    mcpServers: { glade: { type: 'sdk', name: 'glade', instance: {} as never } },
    log: sessionLog.logger.with({ taskId: 'task-1' }),
  })
  await vi.waitFor(() => {
    expect(sdk.query).toHaveBeenCalledOnce()
  })

  expect(backendLog.records).toEqual([])
  expect(sessionLog.withMessage('agent process starting')).toEqual([
    expect.objectContaining({
      level: LogLevel.Info,
      fields: {
        taskId: 'task-1',
        // Outside a packaged app the SDK finds Claude Code itself.
        executable: null,
        cwd: '/code/acme-api',
        model: 'claude-sample-1',
        effort: Effort.High,
        permissionMode: PermissionMode.AllowAll,
        resumeSessionId: 'session-1',
        mcpServers: ['glade'],
        allowedTools: ['mcp__glade'],
        PATH: '/opt/homebrew/bin:/usr/bin:/bin',
      },
    }),
  ])
  expect(JSON.stringify(sessionLog.records)).not.toContain('sk-ant-sample')
  session.close()
})

it("logs to the backend's own log when the session has none, and says when there's no PATH", async () => {
  const log = createMemoryLog(LogScope.Agent)
  const session = createSdkBackend({ version: '1.2.3', env: Promise.resolve({}), log: log.logger }).start(OPTIONS)
  await vi.waitFor(() => {
    expect(sdk.query).toHaveBeenCalledOnce()
  })

  expect(log.withMessage('agent process starting')[0]?.fields).toMatchObject({ PATH: null })
  session.close()
})

it('logs an interrupt, a stopped task and the process closing', async () => {
  const log = createMemoryLog(LogScope.Agent)
  const session = createSdkBackend({ version: '1.2.3', env: Promise.resolve(ENV) }).start({
    ...OPTIONS,
    log: log.logger,
  })
  await vi.waitFor(() => {
    expect(sdk.query).toHaveBeenCalledOnce()
  })

  await session.interrupt()
  await session.stopTask('b7f3')
  session.close()

  expect(log.records.map(({ message, fields }) => ({ message, fields }))).toEqual([
    { message: 'agent process starting', fields: expect.objectContaining({ cwd: '/code/acme-api' }) as unknown },
    { message: 'agent interrupted', fields: {} },
    { message: 'agent task stopped', fields: { sdkTaskId: 'b7f3' } },
    { message: 'agent process closing', fields: {} },
  ])
})

it('logs nothing anywhere when given no log at all', async () => {
  const spies = (['debug', 'info', 'warn', 'error', 'log'] as const).map((level) => vi.spyOn(console, level))
  const session = createSdkBackend({ version: '1.2.3', env: Promise.resolve(ENV) }).start(OPTIONS)
  await session.interrupt()
  session.close()

  for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  vi.restoreAllMocks()
})
