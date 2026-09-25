// The SDK adapter, with the SDK's `query()` replaced: what it passes to the SDK, and how it drives the session.
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { beforeEach, expect, it, vi } from 'vitest'
import { Effort } from '../../shared/domain'
import type { Environment } from '../login-env'
import type { AgentSessionOptions } from './backend'
import { claudeCodeExecutable, createSdkBackend, sdkOptions, userMessage } from './sdk-backend'
import { createMemoryLog } from '../logging/memory-sink'
import { LogLevel, LogScope } from '../logging/logger'

const sdk = vi.hoisted(() => {
  const session = {
    interrupt: vi.fn(() => Promise.resolve(undefined)),
    stopTask: vi.fn<(taskId: string) => Promise<void>>(() => Promise.resolve(undefined)),
    setModel: vi.fn<(model?: string) => Promise<void>>(() => Promise.resolve(undefined)),
    applyFlagSettings: vi.fn<(settings: unknown) => Promise<void>>(() => Promise.resolve(undefined)),
    close: vi.fn(),
    // The session's stream: one message, then done.
    [Symbol.asyncIterator]: vi.fn(async function* () {
      yield await Promise.resolve({ type: 'system', subtype: 'init' })
    }),
  }
  return {
    session,
    query: vi.fn<(params: { prompt: AsyncIterable<unknown>; options: unknown }) => typeof session>(() => session),
  }
})

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }))

const OPTIONS: AgentSessionOptions = {
  cwd: '/code/acme-api',
  model: 'claude-sample-1',
  effort: Effort.High,
  resumeSessionId: null,
  systemPromptAppend: 'You are running inside Glade.',
  mcpServers: {},
}

/** The environment the sessions run in: a login shell's. */
const ENV: Environment = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: '/Users/sample' }

/** A backend whose sessions run in `ENV`. */
const backendIn = (env: Environment = ENV): ReturnType<typeof createSdkBackend> =>
  createSdkBackend({ env: Promise.resolve(env) })

beforeEach(() => {
  vi.clearAllMocks()
})

it('runs the session in the workspace root, allowing all, with the workspace and user settings and the prompt', () => {
  expect(sdkOptions(OPTIONS, ENV)).toEqual({
    env: { ...ENV, CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
    cwd: '/code/acme-api',
    model: 'claude-sample-1',
    effort: 'high',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are running inside Glade.' },
    mcpServers: {},
    disallowedTools: ['AskUserQuestion'],
    forwardSubagentText: true,
  })
})

const PACKAGED = '/Applications/Glade.app/Contents/Resources/app.asar/node_modules/@anthropic-ai'

it('runs the unpacked Claude Code binary when the platform package is inside the asar archive', () => {
  const resolve = vi.fn(() => `${PACKAGED}/claude-agent-sdk-darwin-arm64/claude`)

  expect(claudeCodeExecutable(resolve, 'darwin', 'arm64')).toBe(
    '/Applications/Glade.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
  )
  expect(resolve).toHaveBeenCalledWith('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude')
})

it("leaves the binary to the SDK when it isn't packaged, or there's no platform package", () => {
  expect(
    claudeCodeExecutable(() => '/code/glade/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'),
  ).toBe(undefined)
  expect(
    claudeCodeExecutable(() => {
      throw new Error('Cannot find module')
    }),
  ).toBe(undefined)
})

it('passes the unpacked binary to the SDK in the packaged app', () => {
  expect(sdkOptions(OPTIONS, ENV, () => `${PACKAGED}/claude-agent-sdk-darwin-arm64/claude`)).toMatchObject({
    pathToClaudeCodeExecutable: expect.stringContaining('/app.asar.unpacked/node_modules/') as unknown,
  })
})

it('resumes a saved session and passes the MCP servers on', () => {
  const glade = { type: 'http' as const, url: 'http://127.0.0.1:1/mcp' }

  expect(sdkOptions({ ...OPTIONS, resumeSessionId: 'session-1', mcpServers: { glade } }, ENV)).toMatchObject({
    resume: 'session-1',
    mcpServers: { glade },
  })
})

it("sends the user's message as a top-level message typed by a person", () => {
  expect(userMessage('Hi', 'uuid-1')).toEqual({
    type: 'user',
    uuid: 'uuid-1',
    parent_tool_use_id: null,
    origin: { kind: 'human' },
    message: { role: 'user', content: 'Hi' },
  })
})

it("gives each session its own copy of the environment, since the SDK adds to the one it's given", () => {
  const options = sdkOptions(OPTIONS, ENV)
  expect(options.env).toMatchObject(ENV)
  expect(options.env).not.toBe(ENV)
  expect(ENV).not.toHaveProperty('CLAUDE_CODE_ENABLE_TODO_TOOLS')
})

// The bundled Claude Code leaves its todo tools off for SDK sessions on newer models unless this is set, and the Todos
// tab reads them (#167, docs/sdk-notes.md §10).
it("turns Claude Code's todo tools on for every session, whatever the model", () => {
  for (const model of ['claude-opus-5-5[1m]', 'claude-sonnet-5', 'claude-haiku-4-5']) {
    expect(sdkOptions({ ...OPTIONS, model }, ENV).env).toMatchObject({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' })
  }
})

it('leaves the tools the agent schedules its own follow-ups with on: none disallowed, and nothing turning them off', () => {
  const options = sdkOptions(OPTIONS, ENV)
  const followUpTools = ['Bash', 'Agent', 'Task', 'Monitor', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'TaskStop']
  expect(options.disallowedTools?.filter((tool) => followUpTools.includes(tool))).toEqual([])
  expect(options.tools).toBeUndefined()
  expect(options.allowedTools).toBeUndefined()
  expect(options.env).not.toHaveProperty('CLAUDE_CODE_DISABLE_CRON')
  expect(options.env).not.toHaveProperty('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS')
})

it("turns the todo tools on even when the login shell turns them off, and leaves the tasks' own switch alone", () => {
  const env = sdkOptions(OPTIONS, { ...ENV, CLAUDE_CODE_ENABLE_TODO_TOOLS: '0' }).env
  expect(env).toMatchObject({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' })
  expect(env).not.toHaveProperty('CLAUDE_CODE_ENABLE_TASKS')
})

/** Lets the environment's promise, and the `query()` waiting on it, settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

it('starts one streaming-input query per session, in the environment, and pushes each message into it', async () => {
  const session = backendIn().start(OPTIONS)
  await settle()

  expect(sdk.query).toHaveBeenCalledExactlyOnceWith({
    prompt: expect.anything() as unknown,
    options: sdkOptions(OPTIONS, ENV),
  })
  const streamed: unknown[] = []
  for await (const message of session.messages) streamed.push(message)
  expect(streamed).toEqual([{ type: 'system', subtype: 'init' }])
  const prompt = sdk.query.mock.calls[0]?.[0].prompt as AsyncIterable<SDKUserMessage>

  session.send('Hi', 'uuid-1')
  session.send('Fix it.', 'uuid-2')
  await session.interrupt()
  await session.stopTask('b7f3')
  session.close()

  const pushed: SDKUserMessage[] = []
  for await (const message of prompt) pushed.push(message)
  expect(pushed).toEqual([userMessage('Hi', 'uuid-1'), userMessage('Fix it.', 'uuid-2')])
  expect(sdk.session.interrupt).toHaveBeenCalledOnce()
  expect(sdk.session.stopTask).toHaveBeenCalledExactlyOnceWith('b7f3')
  expect(sdk.session.close).toHaveBeenCalledOnce()
})

/** The messages pushed into a session's prompt: its first `count`. */
async function pushedMessages(count: number): Promise<string[]> {
  await settle()
  const prompt = sdk.query.mock.calls[0]?.[0].prompt as AsyncIterable<SDKUserMessage>
  const pushed: string[] = []
  for await (const message of prompt) {
    const { content } = message.message
    pushed.push(typeof content === 'string' ? content : JSON.stringify(content))
    if (pushed.length === count) break
  }
  return pushed
}

it('changes the model and effort before delivering the next message, never after', async () => {
  const order: string[] = []
  sdk.session.setModel.mockImplementation((model?: string) => {
    order.push(`model ${String(model)}`)
    return Promise.resolve(undefined)
  })
  sdk.session.applyFlagSettings.mockImplementation((settings: unknown) => {
    order.push(`flags ${JSON.stringify(settings)}`)
    return Promise.resolve(undefined)
  })
  const session = backendIn().start(OPTIONS)

  session.send('Hi', 'uuid-1')
  session.configure({ model: 'claude-sample-2', effort: Effort.Max })
  session.send('Fix it.', 'uuid-2')
  const pushed = await pushedMessages(2)

  expect(pushed).toEqual(['Hi', 'Fix it.'])
  expect(order).toEqual(['model claude-sample-2', 'flags {"effortLevel":"max"}'])
  expect(sdk.session.setModel).toHaveBeenCalledBefore(sdk.session.applyFlagSettings)
})

it('still delivers the message, on the old settings, when the SDK refuses a change', async () => {
  sdk.session.setModel.mockRejectedValueOnce(new Error('model_not_found'))
  const log = createMemoryLog(LogScope.Agent)
  const session = createSdkBackend({ env: Promise.resolve(ENV), log: log.logger }).start(OPTIONS)

  session.configure({ model: 'claude-missing', effort: Effort.Low })
  session.send('Hi', 'uuid-1')

  expect(await pushedMessages(1)).toEqual(['Hi'])
  expect(log.withMessage("the SDK refused the session's new settings")).toEqual([
    expect.objectContaining({
      level: LogLevel.Warn,
      fields: { model: 'claude-missing', effort: Effort.Low, error: expect.any(Error) as unknown },
    }),
  ])
  expect(sdk.session.applyFlagSettings).not.toHaveBeenCalled()
})

/** A promise, and what settles it. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

it("doesn't start the agent until the environment is known, then does what was asked of it meanwhile, in order", async () => {
  const env = deferred<Environment>()
  const session = createSdkBackend({ env: env.promise }).start(OPTIONS)

  session.send('Hi', 'uuid-1')
  session.configure({ model: 'claude-sample-2', effort: Effort.Max })
  session.send('Fix it.', 'uuid-2')
  const interrupted = session.interrupt()
  const stopped = session.stopTask('b7f3')
  const streamed: unknown[] = []
  const reading = (async () => {
    for await (const message of session.messages) streamed.push(message)
  })()
  await settle()

  expect(sdk.query).not.toHaveBeenCalled()
  expect(sdk.session.setModel).not.toHaveBeenCalled()
  expect(sdk.session.interrupt).not.toHaveBeenCalled()
  expect(streamed).toEqual([])

  env.resolve(ENV)
  await Promise.all([interrupted, stopped, reading])

  expect(sdk.query).toHaveBeenCalledExactlyOnceWith({
    prompt: expect.anything() as unknown,
    options: sdkOptions(OPTIONS, ENV),
  })
  expect(await pushedMessages(2)).toEqual(['Hi', 'Fix it.'])
  expect(sdk.session.setModel).toHaveBeenCalledExactlyOnceWith('claude-sample-2')
  expect(sdk.session.interrupt).toHaveBeenCalledOnce()
  expect(sdk.session.stopTask).toHaveBeenCalledExactlyOnceWith('b7f3')
  expect(streamed).toEqual([{ type: 'system', subtype: 'init' }])
})

it('closes a session closed before its environment was known once its agent starts, having given it what was sent', async () => {
  const env = deferred<Environment>()
  const session = createSdkBackend({ env: env.promise }).start(OPTIONS)

  session.send('Hi', 'uuid-1')
  session.close()
  await settle()
  expect(sdk.session.close).not.toHaveBeenCalled()

  env.resolve(ENV)
  await settle()

  expect(sdk.session.close).toHaveBeenCalledOnce()
  const prompt = sdk.query.mock.calls[0]?.[0].prompt as AsyncIterable<SDKUserMessage>
  const pushed: SDKUserMessage[] = []
  for await (const message of prompt) pushed.push(message)
  expect(pushed).toEqual([userMessage('Hi', 'uuid-1')])
})

it("runs each session in the environment it's given, whatever Glade's own is", async () => {
  vi.stubEnv('PATH', '/usr/bin:/bin:/usr/sbin:/sbin')
  backendIn({ PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' }).start(OPTIONS)
  await settle()
  vi.unstubAllEnvs()

  expect(sdk.query.mock.calls[0]?.[0].options).toMatchObject({
    env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
  })
})
