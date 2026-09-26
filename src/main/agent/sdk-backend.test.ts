// The SDK adapter, with the SDK's `query()` replaced: what it passes to the SDK, and how it drives the session.
import type {
  CanUseTool,
  McpSdkServerConfigWithInstance,
  PermissionUpdate,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { beforeEach, expect, it, vi } from 'vitest'
import {
  Effort,
  PermissionDestination,
  PermissionMode,
  PermissionRuleBehavior,
  PermissionUpdateType,
} from '../../shared/domain'
import type { Environment } from '../login-env'
import {
  ToolPermissionBehavior,
  type AgentSessionOptions,
  type ToolPermissionAnswer,
  type ToolPermissionCall,
} from './backend'
import { GIF, JPEG, PNG } from '../../shared/test-images'
import {
  canUseToolFor,
  claudeCodeExecutable,
  createSdkBackend,
  NO_ONE_TO_ASK,
  PERMISSION_FAILED,
  sdkOptions,
  sdkPermissionResult,
  sdkPermissionMode,
  toolPermissionCall,
  userMessage,
} from './sdk-backend'
import { createMemoryLog } from '../logging/memory-sink'
import { LogLevel, LogScope } from '../logging/logger'

const sdk = vi.hoisted(() => {
  const session = {
    interrupt: vi.fn(() => Promise.resolve(undefined)),
    stopTask: vi.fn<(taskId: string) => Promise<void>>(() => Promise.resolve(undefined)),
    setModel: vi.fn<(model?: string) => Promise<void>>(() => Promise.resolve(undefined)),
    applyFlagSettings: vi.fn<(settings: unknown) => Promise<void>>(() => Promise.resolve(undefined)),
    setPermissionMode: vi.fn<(mode: string) => Promise<void>>(() => Promise.resolve(undefined)),
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
  permissionMode: PermissionMode.AllowAll,
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
    canUseTool: expect.any(Function) as unknown,
    allowedTools: [],
    settingSources: ['user', 'project', 'local'],
    settings: { deniedMcpServers: [{ serverName: 'glade-control' }] },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are running inside Glade.' },
    mcpServers: {},
    disallowedTools: ['AskUserQuestion'],
    forwardSubagentText: true,
    agentProgressSummaries: true,
  })
})

it("keeps a glade-control server of the user's own config out, so the in-process one is the only one", () => {
  const inProcess = { type: 'sdk', name: 'glade-control', instance: {} } as unknown as McpSdkServerConfigWithInstance

  const options = sdkOptions({ ...OPTIONS, mcpServers: { 'glade-control': inProcess } }, ENV)

  // Claude Code would otherwise join the user's `claude mcp add … glade-control` to it (docs/sdk-notes.md §12); the
  // denylist doesn't reach an SDK server.
  expect(options.settings).toEqual({ deniedMcpServers: [{ serverName: 'glade-control' }] })
  expect(options.mcpServers).toEqual({ 'glade-control': inProcess })
  expect(options.settingSources).toEqual(['user', 'project', 'local'])
})

it("adds the session's own variables to the login shell's environment, under the ones Glade always sets", () => {
  const options = sdkOptions(
    { ...OPTIONS, env: { GLADE_CONTROL_URL: 'http://127.0.0.1:45233', CLAUDE_CODE_ENABLE_TODO_TOOLS: '0' } },
    ENV,
  )

  expect(options.env).toEqual({
    ...ENV,
    GLADE_CONTROL_URL: 'http://127.0.0.1:45233',
    CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
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

it("sends the images pasted into the user's message as image content blocks, before its text", () => {
  expect(userMessage('Compare these.', 'uuid-1', [PNG, JPEG]).message).toEqual({
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.data } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG.data } },
      { type: 'text', text: 'Compare these.' },
    ],
  })
  expect(userMessage('Hi', 'uuid-2', []).message.content).toBe('Hi')
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
  // `allowedTools` only pre-approves Glade's own tools (P11-01): it doesn't limit which tools the session has.
  expect(options.allowedTools?.filter((tool) => !tool.startsWith('mcp__'))).toEqual([])
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
    options: { ...sdkOptions(OPTIONS, ENV), canUseTool: expect.any(Function) as unknown },
  })
  const streamed: unknown[] = []
  for await (const message of session.messages) streamed.push(message)
  expect(streamed).toEqual([{ type: 'system', subtype: 'init' }])
  const prompt = sdk.query.mock.calls[0]?.[0].prompt as AsyncIterable<SDKUserMessage>

  session.send('Hi', 'uuid-1')
  session.send('Fix it.', 'uuid-2', [GIF])
  await session.interrupt()
  await session.stopTask('b7f3')
  session.close()

  const pushed: SDKUserMessage[] = []
  for await (const message of prompt) pushed.push(message)
  expect(pushed).toEqual([userMessage('Hi', 'uuid-1'), userMessage('Fix it.', 'uuid-2', [GIF])])
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
  session.configure({ model: 'claude-sample-2', effort: Effort.Max, permissionMode: PermissionMode.AllowAll })
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

  session.configure({ model: 'claude-missing', effort: Effort.Low, permissionMode: PermissionMode.AllowAll })
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
  session.configure({ model: 'claude-sample-2', effort: Effort.Max, permissionMode: PermissionMode.AllowAll })
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
    options: { ...sdkOptions(OPTIONS, ENV), canUseTool: expect.any(Function) as unknown },
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

// Per-call permission review (docs/decisions.md; docs/sdk-notes.md §9).

it('runs Allow all bypassing every check, and the ask mode in default, where Claude Code asks canUseTool', () => {
  expect(sdkPermissionMode(PermissionMode.AllowAll)).toBe('bypassPermissions')
  expect(sdkPermissionMode(PermissionMode.AskBeforeEdits)).toBe('default')
  const asking = sdkOptions({ ...OPTIONS, permissionMode: PermissionMode.AskBeforeEdits }, ENV)
  expect(asking).toMatchObject({ permissionMode: 'default', allowDangerouslySkipPermissions: true })
  expect(asking.canUseTool).toEqual(expect.any(Function))
})

it("lets Glade's own MCP servers' tools through without asking, whatever the mode", () => {
  const glade = { type: 'http' as const, url: 'http://127.0.0.1:1/mcp' }
  for (const permissionMode of Object.values(PermissionMode)) {
    expect(sdkOptions({ ...OPTIONS, permissionMode, mcpServers: { glade } }, ENV).allowedTools).toEqual(['mcp__glade'])
  }
})

it("pre-approves only glade's tools: another in-process server's, such as glade-control's, go to canUseTool", () => {
  const server = { type: 'http' as const, url: 'http://127.0.0.1:1/mcp' }
  const mcpServers = { glade: server, 'glade-control': server, acme: server }
  for (const permissionMode of Object.values(PermissionMode)) {
    expect(sdkOptions({ ...OPTIONS, permissionMode, mcpServers }, ENV).allowedTools).toEqual(['mcp__glade'])
  }
  expect(sdkOptions({ ...OPTIONS, mcpServers: { 'glade-control': server } }, ENV).allowedTools).toEqual([])
})

/** `canUseTool`'s options, as the SDK passes them for a plain call (the shape probed in §9). */
function canUseOptions(extra: Partial<Parameters<CanUseTool>[2]> = {}): Parameters<CanUseTool>[2] {
  return { signal: new AbortController().signal, toolUseID: 'toolu_1', requestId: 'request-1', ...extra }
}

it('parses a canUseTool call into Glade’s terms, keeping the suggestions it knows and logging the rest', () => {
  const log = createMemoryLog(LogScope.Agent)
  const signal = new AbortController().signal
  const bashRule: PermissionUpdate = {
    type: 'addRules',
    rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
    behavior: 'allow',
    destination: 'localSettings',
  }
  const unknownSuggestion = { type: 'grantEverything', destination: 'session' }

  const call = toolPermissionCall(
    'Bash',
    { command: 'npm test' },
    canUseOptions({
      signal,
      agentID: 'ac2cfaf3cec2364e5',
      title: 'Claude wants to run npm test',
      displayName: 'Bash',
      description: 'Run the test suite',
      suggestions: [
        bashRule,
        unknownSuggestion as never,
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      ],
      defaultToNo: true,
      suppressAlwaysAllowRule: true,
      matchedAskRule: { source: 'userSettings', toolName: 'Bash' },
    }),
    log.logger,
  )

  expect(call).toEqual({
    toolName: 'Bash',
    input: { command: 'npm test' },
    toolUseId: 'toolu_1',
    agentId: 'ac2cfaf3cec2364e5',
    title: 'Claude wants to run npm test',
    displayName: 'Bash',
    description: 'Run the test suite',
    suggestions: [
      {
        type: PermissionUpdateType.AddRules,
        rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
        behavior: PermissionRuleBehavior.Allow,
        destination: PermissionDestination.LocalSettings,
      },
      { type: PermissionUpdateType.SetMode, mode: 'acceptEdits', destination: PermissionDestination.Session },
    ],
    defaultToNo: true,
    suppressAlwaysAllowRule: true,
    mcpServer: null,
    matchedAskRule: true,
    signal,
  })
  expect(log.withMessage('ignored a permission suggestion of a shape Glade does not know')).toEqual([
    expect.objectContaining({ level: LogLevel.Warn, fields: { suggestion: unknownSuggestion } }),
  ])
})

it('fills in what a bare canUseTool call leaves out, and keeps an MCP tool’s server as the SDK names it', () => {
  expect(toolPermissionCall('Edit', { file_path: 'a.txt' }, canUseOptions())).toMatchObject({
    agentId: null,
    title: null,
    displayName: null,
    description: null,
    suggestions: [],
    defaultToNo: false,
    suppressAlwaysAllowRule: false,
    mcpServer: null,
    matchedAskRule: false,
  })
  expect(
    toolPermissionCall('mcp__glade__set_status', {}, canUseOptions({ mcpServer: { name: 'glade', source: 'sdk' } })),
  ).toMatchObject({ mcpServer: { name: 'glade', source: 'sdk' } })
})

it('answers the SDK with what was decided: the input as it was, and a person’s decision classified as theirs', async () => {
  const answers: ToolPermissionAnswer[] = [
    { behavior: ToolPermissionBehavior.Allow, byUser: false },
    { behavior: ToolPermissionBehavior.Allow, byUser: true },
    { behavior: ToolPermissionBehavior.Deny, message: 'Denied: use pnpm.', byUser: true },
    { behavior: ToolPermissionBehavior.Deny, message: 'Withdrawn.', byUser: false },
  ]
  const queue = [...answers]
  const seen: ToolPermissionCall[] = []
  const canUseTool = canUseToolFor((call) => {
    seen.push(call)
    const answer = queue.shift()
    return answer === undefined ? Promise.reject(new Error('asked too often')) : Promise.resolve(answer)
  }, createMemoryLog(LogScope.Agent).logger)
  const input = { command: 'npm test' }

  const results = []
  while (results.length < answers.length) results.push(await canUseTool('Bash', input, canUseOptions()))

  expect(results).toEqual([
    { behavior: 'allow', updatedInput: input },
    { behavior: 'allow', updatedInput: input, decisionClassification: 'user_temporary' },
    { behavior: 'deny', message: 'Denied: use pnpm.', decisionClassification: 'user_reject' },
    { behavior: 'deny', message: 'Withdrawn.' },
  ])
  expect(seen.map(({ toolName, toolUseId }) => [toolName, toolUseId])).toEqual(answers.map(() => ['Bash', 'toolu_1']))
})

it('hands a rule granted for the task to the session only, classified as always allowed, never to a settings file', async () => {
  const input = { command: 'npm test -- --watch' }
  const prefix = { toolName: 'Bash', ruleContent: 'npm test *' }
  const canUseTool = canUseToolFor(
    () => Promise.resolve({ behavior: ToolPermissionBehavior.Allow, byUser: true, rule: prefix }),
    createMemoryLog(LogScope.Agent).logger,
  )

  const result = await canUseTool('Bash', input, canUseOptions())

  const updates: PermissionUpdate[] = [{ type: 'addRules', rules: [prefix], behavior: 'allow', destination: 'session' }]
  expect(result).toEqual({
    behavior: 'allow',
    updatedInput: input,
    updatedPermissions: updates,
    decisionClassification: 'user_permanent',
  })
  // A whole tool's rule goes without content.
  expect(
    sdkPermissionResult({ behavior: ToolPermissionBehavior.Allow, byUser: true, rule: { toolName: 'Edit' } }, {}),
  ).toMatchObject({ updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Edit' }] }] })
})

it("passes the task's granted rules as allowedTools on every start and resume, after Glade's own servers", () => {
  const glade = { type: 'http' as const, url: 'http://127.0.0.1:1/mcp' }
  const allowedRules = [
    { toolName: 'Bash', ruleContent: 'npm test *' },
    { toolName: 'Edit' },
    { toolName: 'Bash', ruleContent: "touch 'a(1).txt'" },
  ]
  for (const resumeSessionId of [null, 'session-1']) {
    for (const permissionMode of Object.values(PermissionMode)) {
      expect(
        sdkOptions({ ...OPTIONS, resumeSessionId, permissionMode, mcpServers: { glade }, allowedRules }, ENV)
          .allowedTools,
      ).toEqual(['mcp__glade', 'Bash(npm test *)', 'Edit', "Bash(touch 'a\\(1\\).txt')"])
    }
  }
  // Never as settings: the SDK's settings sources stay the user's own.
  expect(sdkOptions({ ...OPTIONS, allowedRules }, ENV).settingSources).toEqual(['user', 'project', 'local'])
})

it('denies a call with no one to ask about it, and one whose deciding failed, saying so', async () => {
  const log = createMemoryLog(LogScope.Agent)

  await expect(canUseToolFor(undefined, log.logger)('Bash', {}, canUseOptions())).resolves.toEqual({
    behavior: 'deny',
    message: NO_ONE_TO_ASK,
  })
  const failing = canUseToolFor(() => Promise.reject(new Error('database is locked')), log.logger)
  await expect(failing('Edit', {}, canUseOptions())).resolves.toEqual({ behavior: 'deny', message: PERMISSION_FAILED })
  expect(log.withMessage('failed to decide a tool call')).toEqual([
    expect.objectContaining({
      level: LogLevel.Error,
      fields: { toolName: 'Edit', toolUseId: 'toolu_1', error: expect.any(Error) as unknown },
    }),
  ])
})

it('asks the handler it was started with about each call, through the SDK’s canUseTool', async () => {
  const onToolPermission = vi.fn<(call: ToolPermissionCall) => Promise<ToolPermissionAnswer>>(() =>
    Promise.resolve({ behavior: ToolPermissionBehavior.Allow, byUser: true }),
  )
  backendIn().start({ ...OPTIONS, permissionMode: PermissionMode.AskBeforeEdits, onToolPermission })
  await settle()
  const { canUseTool } = sdk.query.mock.calls[0]?.[0].options as { canUseTool: CanUseTool }

  await expect(canUseTool('Write', { file_path: 'c.txt' }, canUseOptions())).resolves.toMatchObject({
    behavior: 'allow',
  })
  expect(onToolPermission).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ toolName: 'Write', input: { file_path: 'c.txt' }, toolUseId: 'toolu_1' }),
  )
})

it('switches a live session’s permission mode in order with its messages, and nothing else when only it changed', async () => {
  const order: string[] = []
  sdk.session.setPermissionMode.mockImplementation((mode: string) => {
    order.push(`mode ${mode}`)
    return Promise.resolve(undefined)
  })
  const log = createMemoryLog(LogScope.Agent)
  const session = createSdkBackend({ env: Promise.resolve(ENV), log: log.logger }).start(OPTIONS)
  const { model, effort } = OPTIONS

  session.send('Hi', 'uuid-1')
  session.configure({ model, effort, permissionMode: PermissionMode.AskBeforeEdits })
  session.configure({ model, effort, permissionMode: PermissionMode.AllowAll })
  session.send('Fix it.', 'uuid-2')
  expect(await pushedMessages(2)).toEqual(['Hi', 'Fix it.'])

  expect(order).toEqual(['mode default', 'mode bypassPermissions'])
  expect(sdk.session.setModel).not.toHaveBeenCalled()
  expect(sdk.session.applyFlagSettings).not.toHaveBeenCalled()
  expect(log.withMessage('permission mode changed').map(({ fields }) => fields)).toEqual([
    { permissionMode: PermissionMode.AskBeforeEdits },
    { permissionMode: PermissionMode.AllowAll },
  ])
})

it('changes the model and the permission mode together, and still delivers the message when the SDK refuses the mode', async () => {
  sdk.session.setPermissionMode.mockRejectedValueOnce(new Error('mode refused'))
  const log = createMemoryLog(LogScope.Agent)
  const session = createSdkBackend({ env: Promise.resolve(ENV), log: log.logger }).start(OPTIONS)

  session.configure({ model: 'claude-sample-2', effort: Effort.High, permissionMode: PermissionMode.AskBeforeEdits })
  session.send('Hi', 'uuid-1')

  expect(await pushedMessages(1)).toEqual(['Hi'])
  expect(sdk.session.setModel).toHaveBeenCalledExactlyOnceWith('claude-sample-2')
  expect(sdk.session.setPermissionMode).toHaveBeenCalledExactlyOnceWith('default')
  expect(log.withMessage("the SDK refused the session's new permission mode")).toEqual([
    expect.objectContaining({
      level: LogLevel.Warn,
      fields: { permissionMode: PermissionMode.AskBeforeEdits, error: expect.any(Error) as unknown },
    }),
  ])
})
