// The SDK adapter's sandbox plumbing (`docs/sdk-notes.md` §15), with the SDK's `query()` replaced: the sandbox and
// permissions a session starts with, `applyFlagSettings` on a live one, and the `Bash` hooks that hold the turn.
import type { HookInput, Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { beforeEach, expect, it, vi } from 'vitest'
import { Effort, PermissionMode } from '../../shared/domain'
import { LogLevel, LogScope } from '../logging/logger'
import { createMemoryLog } from '../logging/memory-sink'
import {
  PromptVerdict,
  ToolPermissionBehavior,
  type AgentSessionOptions,
  type BashCallFinished,
  type BashFinishedAnswer,
  type SandboxFlagSettings,
  type SessionHooks,
  type ToolCallStarting,
  type ToolStartDecision,
} from './backend'
import {
  BASH_FINISHED_TIMEOUT_S,
  COMMAND_TOOLS,
  createSdkBackend,
  DISALLOWED_TOOLS,
  isSandboxed,
  SANDBOX_CHECK_FAILED,
  SANDBOX_DISALLOWED_TOOLS,
  SANDBOX_TOOLS,
  sandboxToolGuard,
  sdkFlagSettings,
  sdkHooks,
  sdkOptions,
  sdkPermissionMode,
  sdkSandbox,
} from './sdk-backend'
import { sandboxOverlay, sandboxStartSettings } from './sandbox'

const sdk = vi.hoisted(() => {
  const session = {
    applyFlagSettings: vi.fn<(settings: unknown) => Promise<void>>(() => Promise.resolve(undefined)),
    setPermissionMode: vi.fn<(mode: string) => Promise<void>>(() => Promise.resolve(undefined)),
    close: vi.fn(),
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

const ROOT = '/Users/me/src/acme-api'

const OPTIONS: AgentSessionOptions = {
  cwd: ROOT,
  model: 'claude-sample-1',
  effort: Effort.High,
  permissionMode: PermissionMode.AllowAll,
  resumeSessionId: null,
  systemPromptAppend: 'You are running inside Glade.',
  mcpServers: {},
}

/** What a sandboxed session starts with: the parts no grant changes (`docs/sdk-notes.md` §15). */
const BASE: SandboxFlagSettings = {
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    filesystem: { denyRead: ['~', '/Users', '/Volumes'], allowRead: [ROOT], allowWrite: [ROOT], denyWrite: [] },
    network: { allowedDomains: [] },
    credentials: { files: [{ path: '~/.ssh', mode: 'deny' }] },
  },
  permissions: { ask: ['Bash(dangerouslyDisableSandbox:true)'] },
}

beforeEach(() => {
  vi.clearAllMocks()
})

it('starts a sandboxed session with its sandbox, and its permissions beside the server denylist', () => {
  const options = sdkOptions({ ...OPTIONS, flagSettings: BASE }, {})

  expect(options.sandbox).toEqual(BASE.sandbox)
  expect(options.settings).toEqual({
    deniedMcpServers: [{ serverName: 'glade-control' }],
    permissions: { ask: ['Bash(dangerouslyDisableSandbox:true)'] },
  })
})

it('starts a session without a sandbox when it has none, or a null one', () => {
  for (const flagSettings of [undefined, {}, { sandbox: null, permissions: null }]) {
    const options = sdkOptions({ ...OPTIONS, ...(flagSettings === undefined ? {} : { flagSettings }) }, {})
    expect(options).not.toHaveProperty('sandbox')
    expect(options.settings).toEqual({ deniedMcpServers: [{ serverName: 'glade-control' }] })
  }
})

it('runs Allow all as acceptEdits in a sandboxed session, never bypassing, and the ask mode as default', () => {
  expect(sdkPermissionMode(PermissionMode.AllowAll, true)).toBe('acceptEdits')
  expect(sdkPermissionMode(PermissionMode.AskBeforeEdits, true)).toBe('default')
  expect(sdkPermissionMode(PermissionMode.AllowAll, false)).toBe('bypassPermissions')
  expect(sdkPermissionMode(PermissionMode.AllowAll)).toBe('bypassPermissions')
})

it('knows a session is sandboxed by the sandbox it starts with being on', () => {
  expect(isSandboxed({ flagSettings: BASE })).toBe(true)
  expect(isSandboxed({ flagSettings: { sandbox: { enabled: false } } })).toBe(false)
  expect(isSandboxed({ flagSettings: { sandbox: null } })).toBe(false)
  expect(isSandboxed({ flagSettings: {} })).toBe(false)
  expect(isSandboxed({})).toBe(false)
})

it("starts a sandboxed session's Allow all in acceptEdits, with no way to switch into bypassing", () => {
  const flagSettings = sandboxStartSettings(ROOT, '/Users/me')
  const allowAll = sdkOptions({ ...OPTIONS, flagSettings }, {})
  const asking = sdkOptions({ ...OPTIONS, permissionMode: PermissionMode.AskBeforeEdits, flagSettings }, {})

  expect(allowAll.permissionMode).toBe('acceptEdits')
  expect(allowAll).not.toHaveProperty('allowDangerouslySkipPermissions')
  expect(asking.permissionMode).toBe('default')
  expect(asking).not.toHaveProperty('allowDangerouslySkipPermissions')
  expect(allowAll.sandbox).toEqual(flagSettings.sandbox)
  expect(allowAll.settings).toEqual({
    deniedMcpServers: [{ serverName: 'glade-control' }],
    permissions: { ask: ['Bash(dangerouslyDisableSandbox:true)'], deny: flagSettings.permissions?.deny },
  })
  // The user's own settings still merge in.
  expect(allowAll.settingSources).toEqual(['user', 'project', 'local'])
})

it('starts a session with the sandbox off exactly as before the sandbox', () => {
  const { hooks: offHooks, canUseTool: offCanUseTool, stderr: offStderr, ...off } = sdkOptions(OPTIONS, {})
  expect(off).toEqual({
    env: expect.any(Object) as unknown,
    cwd: ROOT,
    model: 'claude-sample-1',
    effort: Effort.High,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    allowedTools: [],
    settingSources: ['user', 'project', 'local'],
    settings: { deniedMcpServers: [{ serverName: 'glade-control' }] },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are running inside Glade.' },
    mcpServers: {},
    disallowedTools: ['AskUserQuestion'],
    forwardSubagentText: true,
    agentProgressSummaries: true,
    perTaskStopAffordance: true,
  })
  expect([offHooks, offCanUseTool, offStderr].every((value) => value !== undefined)).toBe(true)
})

it("switches a sandboxed session's mode to acceptEdits, not bypassing, and an unsandboxed one's to bypassing", async () => {
  const sandboxed = createSdkBackend({ version: '1.2.3', env: Promise.resolve({}) }).start({
    ...OPTIONS,
    permissionMode: PermissionMode.AskBeforeEdits,
    flagSettings: sandboxStartSettings(ROOT, '/Users/me'),
  })
  void sandboxed.configure({ model: OPTIONS.model, effort: OPTIONS.effort, permissionMode: PermissionMode.AllowAll })
  void sandboxed.configure({
    model: OPTIONS.model,
    effort: OPTIONS.effort,
    permissionMode: PermissionMode.AskBeforeEdits,
  })
  await settle()
  await settle()
  expect(sdk.session.setPermissionMode.mock.calls).toEqual([['acceptEdits'], ['default']])

  sdk.session.setPermissionMode.mockClear()
  const plain = createSdkBackend({ version: '1.2.3', env: Promise.resolve({}) }).start({
    ...OPTIONS,
    permissionMode: PermissionMode.AskBeforeEdits,
  })
  void plain.configure({ model: OPTIONS.model, effort: OPTIONS.effort, permissionMode: PermissionMode.AllowAll })
  await settle()
  await settle()
  expect(sdk.session.setPermissionMode.mock.calls).toEqual([['bypassPermissions']])
})

it("hands the SDK copies of the lists, so the SDK changing them can't change Glade's", () => {
  const allowRead = [ROOT]
  const sandbox = sdkSandbox({ enabled: true, filesystem: { allowRead } })
  sandbox.filesystem?.allowRead?.push('/Users/me')

  expect(allowRead).toEqual([ROOT])
})

it('leaves out of the sandbox what Glade leaves out, and a credential list it gives no files', () => {
  expect(JSON.parse(JSON.stringify(sdkSandbox({ enabled: false })))).toEqual({ enabled: false })
  expect(JSON.parse(JSON.stringify(sdkSandbox({ enabled: true, credentials: {} })))).toEqual({
    enabled: true,
    credentials: {},
  })
})

it('turns flag settings into what applyFlagSettings takes: only the keys given, a null one cleared', () => {
  expect(sdkFlagSettings({})).toEqual({})
  expect(sdkFlagSettings({ sandbox: null, permissions: null })).toEqual({ sandbox: null, permissions: null })
  expect(
    sdkFlagSettings({
      permissions: {
        allow: ['Read(//Users/me/src/acme-shared/**)', 'WebFetch(domain:registry.npmjs.org)'],
        deny: ['Read(//Users/me/.aws/**)'],
        additionalDirectories: ['/Users/me/src/acme-docs'],
      },
    }),
  ).toEqual({
    permissions: {
      allow: ['Read(//Users/me/src/acme-shared/**)', 'WebFetch(domain:registry.npmjs.org)'],
      deny: ['Read(//Users/me/.aws/**)'],
      additionalDirectories: ['/Users/me/src/acme-docs'],
    },
  })
  expect(sdkFlagSettings({ sandbox: BASE.sandbox })).toEqual({ sandbox: BASE.sandbox })
})

/** Lets the environment's promise, and the `query()` waiting on it, settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** The text of the first `count` messages pushed into the session's prompt. */
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

it('applies flag settings in order with the messages around them, and resolves once the SDK has', async () => {
  const order: string[] = []
  sdk.session.applyFlagSettings.mockImplementation((settings: unknown) => {
    order.push(`flags ${JSON.stringify(settings)}`)
    return Promise.resolve(undefined)
  })
  const log = createMemoryLog(LogScope.Agent)
  const session = createSdkBackend({ version: '1.2.3', env: Promise.resolve({}), log: log.logger }).start(OPTIONS)

  session.send('Hi', 'uuid-1')
  const applied = session.applyFlagSettings({ permissions: { allow: ['WebFetch(domain:registry.npmjs.org)'] } })
  session.send('Install it.', 'uuid-2')
  await applied
  order.push('applied')
  const pushed = await pushedMessages(2)

  expect(pushed).toEqual(['Hi', 'Install it.'])
  expect(order).toEqual(['flags {"permissions":{"allow":["WebFetch(domain:registry.npmjs.org)"]}}', 'applied'])
  expect(log.withMessage('sandbox settings changed')).toHaveLength(1)
})

it('rejects a change the SDK refuses, logs it, and still delivers what comes after', async () => {
  sdk.session.applyFlagSettings.mockRejectedValueOnce(new Error('settings_not_applied'))
  const log = createMemoryLog(LogScope.Agent)
  const session = createSdkBackend({ version: '1.2.3', env: Promise.resolve({}), log: log.logger }).start(OPTIONS)

  const applied = session.applyFlagSettings({ sandbox: null })
  session.send('Hi', 'uuid-1')

  await expect(applied).rejects.toThrow('settings_not_applied')
  expect(await pushedMessages(1)).toEqual(['Hi'])
  expect(log.withMessage("the SDK refused the session's new sandbox settings")).toEqual([
    expect.objectContaining({
      level: LogLevel.Warn,
      fields: { settings: { sandbox: null }, error: expect.any(Error) as unknown },
    }),
  ])
})

/** What the SDK passes every hook. */
const HOOK_BASE = { session_id: 's1', transcript_path: '/tmp/s1.jsonl', cwd: ROOT, permission_mode: 'acceptEdits' }

/** A `PostToolUse` input for a `Bash` call that exited 0, as probed. */
function succeeded(command: string, stdout: string, stderr = ''): HookInput {
  return {
    ...HOOK_BASE,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_use_id: 'toolu_01ok',
    tool_input: { command, description: 'Read the notes' },
    tool_response: { stdout, stderr, interrupted: false, isImage: false, noOutputExpected: false },
  }
}

/** A `PostToolUseFailure` input for a `Bash` call that didn't, as probed. */
function failedWith(command: string, error: string): HookInput {
  return {
    ...HOOK_BASE,
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_use_id: 'toolu_01blocked',
    tool_input: { command, description: 'Read the notes' },
    error,
    is_interrupt: false,
  }
}

function handlers(onBashFinished?: SessionHooks['onBashFinished']): SessionHooks {
  return {
    onPrompt: () => PromptVerdict.Allow,
    onTurnEnded: () => undefined,
    onCompacted: () => undefined,
    ...(onBashFinished === undefined ? {} : { onBashFinished }),
  }
}

/** Calls the one hook registered for an event, as the SDK does, with `signal`. */
function call(
  hooks: NonNullable<Options['hooks']>,
  event: 'PostToolUse' | 'PostToolUseFailure',
  input: HookInput,
  signal: AbortSignal = new AbortController().signal,
) {
  const [matcher] = hooks[event] ?? []
  const [hook] = matcher?.hooks ?? []
  if (hook === undefined) throw new Error(`no ${event} hook`)
  return hook(input, 'toolu_01', { signal })
}

const BLOCKED = 'Exit code 1\ncat: /Users/me/src/acme-shared/notes.txt: Operation not permitted'

it('hooks every Bash call that runs, failed or not, only when the session wants to hear of them', () => {
  expect(sdkHooks(handlers())).not.toHaveProperty('PostToolUse')
  const hooks = sdkHooks(handlers(() => Promise.resolve({ context: null })))

  // Claude Code gives a hook 10 minutes unless told otherwise (docs/sdk-notes.md §15); a card can wait far longer.
  const hooked = { matcher: 'Bash|Monitor', hooks: [expect.any(Function)], timeout: BASH_FINISHED_TIMEOUT_S }
  expect(hooks.PostToolUse).toEqual([hooked])
  expect(hooks.PostToolUseFailure).toEqual([hooked])
  expect(BASH_FINISHED_TIMEOUT_S).toBe(2_147_483)
})

it('tells the host of a command the sandbox blocked, and adds what it answers to the result the agent reads', async () => {
  const heard: BashCallFinished[] = []
  const hooks = sdkHooks(
    handlers((finished) => {
      heard.push(finished)
      return Promise.resolve({ context: 'Glade: you may now read /Users/me/src/acme-shared. Run it again.' })
    }),
  )
  const signal = new AbortController().signal

  await expect(
    call(hooks, 'PostToolUseFailure', failedWith('cat /Users/me/src/acme-shared/notes.txt', BLOCKED), signal),
  ).resolves.toEqual({
    hookSpecificOutput: {
      hookEventName: 'PostToolUseFailure',
      additionalContext: 'Glade: you may now read /Users/me/src/acme-shared. Run it again.',
    },
  })
  expect(heard).toEqual([
    {
      toolUseId: 'toolu_01blocked',
      command: 'cat /Users/me/src/acme-shared/notes.txt',
      output: BLOCKED,
      failed: true,
      signal,
    },
  ])
})

it('tells the host of a command that exited 0, with what it printed, and adds nothing for no answer', async () => {
  const heard: BashCallFinished[] = []
  const hooks = sdkHooks(
    handlers((finished) => {
      heard.push(finished)
      return Promise.resolve({ context: null })
    }),
  )

  await expect(call(hooks, 'PostToolUse', succeeded('npm test', 'ok', 'warn: slow'))).resolves.toEqual({})
  await expect(call(hooks, 'PostToolUse', succeeded('true', ''))).resolves.toEqual({})
  expect(heard.map(({ output, failed }) => ({ output, failed }))).toEqual([
    { output: 'ok\nwarn: slow', failed: false },
    { output: '', failed: false },
  ])
})

it('waits as long as the host takes: the result and the turn wait with it', async () => {
  let answer: (answer: BashFinishedAnswer) => void = () => undefined
  const hooks = sdkHooks(
    handlers(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    ),
  )
  let done = false
  const returned = call(hooks, 'PostToolUseFailure', failedWith('cat notes.txt', BLOCKED)).then((output) => {
    done = true
    return output
  })

  await settle()
  expect(done).toBe(false)
  answer({ context: 'Run it again.' })
  await expect(returned).resolves.toMatchObject({ hookSpecificOutput: { additionalContext: 'Run it again.' } })
})

it('tells the host of a Monitor call’s command too, since it runs in the sandbox, but not of one that opens a socket', async () => {
  const heard: BashCallFinished[] = []
  const hooks = sdkHooks(
    handlers((finished) => {
      heard.push(finished)
      return Promise.resolve({ context: null })
    }),
  )
  const failure = 'Sandbox is required but failed to initialize: seatbelt profile rejected. Restart to retry.'
  const monitor = {
    ...failedWith('npm run dev', failure),
    tool_name: 'Monitor',
    tool_use_id: 'toolu_01monitor',
    tool_input: { command: 'npm run dev', description: 'Watch the dev server', timeout_ms: 60_000, persistent: false },
  } as HookInput
  const socket = {
    ...monitor,
    tool_input: { ws: { url: 'wss://events.acme.dev/stream' }, description: 'Deploy events', timeout_ms: 60_000 },
  } as HookInput

  await expect(call(hooks, 'PostToolUseFailure', monitor)).resolves.toEqual({})
  await expect(call(hooks, 'PostToolUseFailure', socket)).resolves.toEqual({})

  expect(COMMAND_TOOLS).toBe('Bash|Monitor')
  expect(heard).toEqual([
    {
      toolUseId: 'toolu_01monitor',
      command: 'npm run dev',
      output: failure,
      failed: true,
      signal: expect.any(AbortSignal) as unknown,
    },
  ])
})

it("adds nothing for input of a shape Glade doesn't know, without asking the host", async () => {
  const onBashFinished = vi.fn(() => Promise.resolve({ context: 'never' }))
  const hooks = sdkHooks(handlers(onBashFinished))

  await expect(
    call(hooks, 'PostToolUse', { ...HOOK_BASE, hook_event_name: 'PostToolUse', tool_name: 'Bash' } as HookInput),
  ).resolves.toEqual({})
  await expect(
    call(hooks, 'PostToolUseFailure', { ...failedWith('ls', BLOCKED), error: 42 } as unknown as HookInput),
  ).resolves.toEqual({})
  expect(onBashFinished).not.toHaveBeenCalled()
})

it("reads a result whose response isn't of a shape Glade knows as printing nothing", async () => {
  const heard: string[] = []
  const hooks = sdkHooks(
    handlers(({ output }) => {
      heard.push(output)
      return Promise.resolve({ context: null })
    }),
  )

  await call(hooks, 'PostToolUse', { ...succeeded('ls', 'a'), tool_response: 'a' } as HookInput)
  await call(hooks, 'PostToolUse', { ...succeeded('ls', 'a'), tool_response: { stdout: 7 } } as unknown as HookInput)

  expect(heard).toEqual(['', ''])
})

it('adds nothing, and logs it, when the host fails to decide', async () => {
  const log = createMemoryLog(LogScope.Agent)
  const hooks = sdkHooks(
    handlers(() => Promise.reject(new Error('database is locked'))),
    log.logger,
  )

  await expect(call(hooks, 'PostToolUseFailure', failedWith('cat notes.txt', BLOCKED))).resolves.toEqual({})
  expect(log.withMessage('failed to note a finished Bash call')).toEqual([
    expect.objectContaining({
      level: LogLevel.Error,
      fields: { toolUseId: 'toolu_01blocked', error: expect.any(Error) as unknown },
    }),
  ])
})

// #514, finding 4: `EnterWorktree {path}` moves the session's working folder into another worktree of the repository,
// outside the workspace root. Claude Code's file tools follow; Glade's bounds stay with the root.
it('offers a sandboxed session no way into another worktree, and any other session what it always had', () => {
  const sandboxed = sdkOptions({ ...OPTIONS, flagSettings: sandboxStartSettings(ROOT, '/Users/me') }, {})
  expect(sandboxed.disallowedTools).toEqual(['AskUserQuestion', 'EnterWorktree', 'ExitWorktree'])
  expect(SANDBOX_DISALLOWED_TOOLS).toEqual(['EnterWorktree', 'ExitWorktree'])

  for (const flagSettings of [undefined, {}, { sandbox: { enabled: false } }]) {
    const plain = sdkOptions({ ...OPTIONS, ...(flagSettings === undefined ? {} : { flagSettings }) }, {})
    expect(plain.disallowedTools).toEqual(['AskUserQuestion'])
  }
  expect(DISALLOWED_TOOLS).toEqual(['AskUserQuestion'])
})

// #514, finding 3 and 5: the switches the user's own settings could turn on underneath, and the control endpoint's
// variables, reach the SDK as Glade sets them.
it('hands the SDK every switch Glade sets off, and the variables it keeps from commands', () => {
  const start = sandboxStartSettings(ROOT, '/Users/me')
  const options = sdkOptions({ ...OPTIONS, flagSettings: start }, {})

  expect(options.sandbox).toMatchObject({
    filesystem: { disabled: false },
    network: { allowedDomains: [], allowLocalBinding: false, allowAllUnixSockets: false, allowUnixSockets: [] },
    credentials: {
      envVars: [
        { name: 'GLADE_CONTROL_URL', mode: 'deny' },
        { name: 'GLADE_CONTROL_TOKEN', mode: 'deny' },
        { name: 'ANTHROPIC_BASE_URL', mode: 'deny' },
        { name: 'ANTHROPIC_AUTH_TOKEN', mode: 'deny' },
      ],
    },
    allowAppleEvents: false,
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    ignoreViolations: {},
  })
  // And again in every overlay, whose `sandbox` replaces the last one's.
  const overlay = sandboxOverlay(ROOT, PermissionMode.AllowAll, { folders: [], domains: [] }, '/Users/me')
  expect(sdkFlagSettings(overlay).sandbox).toMatchObject({
    filesystem: { disabled: false },
    allowAppleEvents: false,
    credentials: {
      envVars: [
        { name: 'GLADE_CONTROL_URL' },
        { name: 'GLADE_CONTROL_TOKEN' },
        { name: 'ANTHROPIC_BASE_URL' },
        { name: 'ANTHROPIC_AUTH_TOKEN' },
      ],
    },
  })
})

it('hands the SDK copies of the new lists too', () => {
  const allowUnixSockets = ['/var/run/docker.sock']
  const denials = ['/usr/bin/true']
  const envVars = [{ name: 'GLADE_CONTROL_TOKEN', mode: 'deny' as const }]
  const sandbox = sdkSandbox({
    enabled: true,
    network: { allowUnixSockets },
    credentials: { envVars },
    ignoreViolations: { '*': denials },
  })
  sandbox.network?.allowUnixSockets?.push('/tmp/other.sock')
  sandbox.ignoreViolations?.['*']?.push('/usr/bin/false')
  sandbox.credentials?.envVars?.push({ name: 'OTHER', mode: 'deny' })

  expect(allowUnixSockets).toEqual(['/var/run/docker.sock'])
  expect(denials).toEqual(['/usr/bin/true'])
  expect(envVars).toHaveLength(1)
  expect(sandbox.ignoreViolations).toEqual({ '*': ['/usr/bin/true', '/usr/bin/false'] })
})

/** A `PreToolUse` input for a call of the agent's own, as the SDK gives it. */
function starting(toolName: string, toolInput: unknown, extra: Record<string, unknown> = {}): HookInput {
  return {
    ...HOOK_BASE,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_use_id: 'toolu_01start',
    tool_input: toolInput,
    ...extra,
  }
}

const DENIED = (reason: string) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
})
const ALLOWED = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }

/** Calls the sandbox's `PreToolUse` hook, as the SDK does. */
function guard(
  onToolStarting: NonNullable<SessionHooks['onToolStarting']>,
  input: HookInput,
  signal: AbortSignal = new AbortController().signal,
  log = createMemoryLog(LogScope.Agent),
) {
  return sandboxToolGuard(onToolStarting, log.logger)(input, 'toolu_01start', { signal })
}

// #514, finding 3: `permissions.allow: ["Write"]` in `~/.claude/settings.json`, or the repository's, and the file tools
// never reached `canUseTool`: `Write ~/Library/LaunchAgents/x.plist` ran with no card. A `PreToolUse` hook runs in
// every permission mode and before any rule is matched.
it('hooks the tools the sandbox bounds before they run, only for a session that asks to hear of them', () => {
  expect(sdkHooks(handlers()).PreToolUse).toHaveLength(1)
  const onToolStarting = (): Promise<ToolStartDecision | null> => Promise.resolve(null)
  const hooks = sdkHooks({ ...handlers(), onToolStarting })

  // After the guard on Glade's own tools, which every session has.
  expect(hooks.PreToolUse).toEqual([
    { hooks: [expect.any(Function)] },
    // As long as a timer allows: Claude Code gives a hook 10 minutes otherwise, and would then run the call.
    { matcher: SANDBOX_TOOLS, hooks: [expect.any(Function)], timeout: BASH_FINISHED_TIMEOUT_S },
  ])
  expect(SANDBOX_TOOLS.split('|').sort()).toEqual(
    [
      'Bash',
      'Edit',
      'Glob',
      'Grep',
      'LS',
      'Monitor',
      'MultiEdit',
      'NotebookEdit',
      'NotebookRead',
      'Read',
      'WebFetch',
      'Write',
      // What reaches outside the sandbox altogether (#515): every MCP tool, and the two that reach other agents.
      'mcp__.*',
      'SendMessage',
      'RemoteTrigger',
    ].sort(),
  )
  // And never for a session with no hooks at all, or one that isn't sandboxed.
  expect(sdkHooks(undefined).PreToolUse).toHaveLength(1)
  expect(sdkOptions(OPTIONS, {}).hooks?.PreToolUse).toHaveLength(1)
})

it('tells the host of a call about to run, and denies it with the host’s message when it says no', async () => {
  const heard: ToolCallStarting[] = []
  const signal = new AbortController().signal
  const refusal = 'Glade refused this: the path is one of the credential files.'

  const output = await guard(
    (call) => {
      heard.push(call)
      return Promise.resolve({ behavior: ToolPermissionBehavior.Deny, message: refusal, byUser: false })
    },
    starting('Write', { file_path: '/Users/me/Library/LaunchAgents/x.plist', content: '<plist/>' }),
    signal,
  )

  expect(output).toEqual(DENIED(refusal))
  expect(heard).toEqual([
    {
      toolName: 'Write',
      input: { file_path: '/Users/me/Library/LaunchAgents/x.plist', content: '<plist/>' },
      mcpServer: null,
      toolUseId: 'toolu_01start',
      agentId: null,
      signal,
    },
  ])
})

// #515: an MCP server Glade doesn't build runs outside the sandbox, and `SendMessage` and `RemoteTrigger` reach
// agents that do. A rule in the user's settings (`permissions.allow: ["mcp__gmail"]`) let its tools through unasked.
it('tells the host of an MCP tool’s call with the server it’s on, as the hook names it', async () => {
  const heard: ToolCallStarting[] = []
  const hear = (call: ToolCallStarting): Promise<null> => {
    heard.push(call)
    return Promise.resolve(null)
  }
  const connector = { name: 'claude.ai Acme Docs', source: 'claudeai' }

  await guard(hear, starting('mcp__claude_ai_Acme_Docs__search', { query: 'retries' }, { mcp_server: connector }))
  // Keys the SDK adds to it later are dropped.
  await guard(hear, starting('mcp__glade__set_title', {}, { mcp_server: { name: 'glade', source: 'sdk', scope: 'x' } }))
  // A hook that doesn't say, or says it in a shape Glade doesn't know: no server Glade can vouch for.
  await guard(hear, starting('mcp__github__create_issue', {}))
  await guard(hear, starting('mcp__github__create_issue', {}, { mcp_server: 'github' }))
  await guard(hear, starting('mcp__github__create_issue', {}, { mcp_server: { name: 7 } }))

  expect(heard.map(({ toolName, mcpServer }) => [toolName, mcpServer])).toEqual([
    ['mcp__claude_ai_Acme_Docs__search', connector],
    ['mcp__glade__set_title', { name: 'glade', source: 'sdk' }],
    ['mcp__github__create_issue', null],
    ['mcp__github__create_issue', null],
    ['mcp__github__create_issue', null],
  ])
})

it('tells the host of `SendMessage` and `RemoteTrigger` calls, and denies one it refuses', async () => {
  const heard: string[] = []
  const refuse = (call: ToolCallStarting): Promise<ToolStartDecision> => {
    heard.push(call.toolName)
    return Promise.resolve({ behavior: ToolPermissionBehavior.Deny, message: 'Denied by the user.', byUser: true })
  }

  const message = starting('SendMessage', { to: 'release-notes', message: 'Hi' })
  await expect(guard(refuse, message)).resolves.toEqual(DENIED('Denied by the user.'))
  await expect(guard(refuse, starting('RemoteTrigger', { action: 'list' }))).resolves.toEqual(
    DENIED('Denied by the user.'),
  )
  expect(heard).toEqual(['SendMessage', 'RemoteTrigger'])
})

it('fails closed for an MCP tool too: a host that throws denies the call', async () => {
  const log = createMemoryLog(LogScope.Agent)
  const output = await guard(
    () => Promise.reject(new Error('no database')),
    starting('mcp__gmail__send', { to: 'sam@acme.dev' }, { mcp_server: { name: 'gmail', source: 'user' } }),
    undefined,
    log,
  )

  expect(output).toEqual(DENIED(SANDBOX_CHECK_FAILED))
})

it('names the subagent whose call it is', async () => {
  const heard: ToolCallStarting[] = []
  await guard(
    (call) => {
      heard.push(call)
      return Promise.resolve(null)
    },
    starting('Read', { file_path: '/Users/me/notes.md' }, { agent_id: 'ac2cfaf3cec2364e5' }),
  )
  expect(heard[0]?.agentId).toBe('ac2cfaf3cec2364e5')
})

it('allows a call the host let through, and says nothing of one it leaves to Claude Code', async () => {
  const allow = (): Promise<ToolStartDecision> =>
    Promise.resolve({ behavior: ToolPermissionBehavior.Allow, byUser: true })
  await expect(guard(allow, starting('WebFetch', { url: 'https://docs.acme.dev/x' }))).resolves.toEqual(ALLOWED)
  await expect(guard(() => Promise.resolve(null), starting('Bash', { command: 'npm test' }))).resolves.toEqual({})
})

it('never answers `ask`: the decision is Glade’s own, whatever Claude Code’s rules would then do with one', async () => {
  for (const decision of [
    { behavior: ToolPermissionBehavior.Allow, byUser: true } as const,
    { behavior: ToolPermissionBehavior.Deny, message: 'No.', byUser: true } as const,
    null,
  ]) {
    const output = await guard(() => Promise.resolve(decision), starting('Read', { file_path: '/Users/me/x' }))
    expect(JSON.stringify(output)).not.toContain('"ask"')
  }
})

it('waits as long as the host takes to decide: the call waits with it', async () => {
  let decide: (decision: ToolStartDecision) => void = () => undefined
  let done = false
  const returned = guard(
    () =>
      new Promise((resolve) => {
        decide = resolve
      }),
    starting('Read', { file_path: '/Users/me/Documents/taxes.pdf' }),
  ).then((output) => {
    done = true
    return output
  })

  await settle()
  await settle()
  expect(done).toBe(false)

  decide({ behavior: ToolPermissionBehavior.Deny, message: 'Denied by the user.', byUser: true })
  await expect(returned).resolves.toEqual(DENIED('Denied by the user.'))
})

it('leaves alone a tool the matcher caught that isn’t one the sandbox bounds, or one that reaches outside it', async () => {
  const onToolStarting = vi.fn<NonNullable<SessionHooks['onToolStarting']>>()

  // A matcher is a pattern: `Read` also matches these.
  await expect(guard(onToolStarting, starting('ReadMcpResource', { uri: 'x' }))).resolves.toEqual({})
  await expect(guard(onToolStarting, starting('SendMessageLater', {}))).resolves.toEqual({})
  await expect(guard(onToolStarting, starting('TodoWrite', {}))).resolves.toEqual({})

  expect(onToolStarting).not.toHaveBeenCalled()
})

it('takes a call with no input, or one that isn’t a record, for one with none', async () => {
  const inputs: unknown[] = []
  const hear = (call: ToolCallStarting): Promise<null> => {
    inputs.push(call.input)
    return Promise.resolve(null)
  }
  await guard(hear, starting('Bash', undefined))
  await guard(hear, starting('Bash', 'ls'))
  expect(inputs).toEqual([{}, {}])
})

it('fails closed: a call it can’t read, or a host that fails to decide, doesn’t run', async () => {
  const log = createMemoryLog(LogScope.Agent)
  const never = vi.fn<NonNullable<SessionHooks['onToolStarting']>>()

  // No `tool_use` id, or no tool at all: nothing to decide by.
  const unnamed = { ...HOOK_BASE, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {} }
  await expect(guard(never, unnamed as HookInput, undefined, log)).resolves.toEqual(DENIED(SANDBOX_CHECK_FAILED))
  await expect(guard(never, { ...HOOK_BASE } as HookInput, undefined, log)).resolves.toEqual(
    DENIED(SANDBOX_CHECK_FAILED),
  )
  expect(never).not.toHaveBeenCalled()
  expect(log.withMessage('refused a tool call whose hook input Glade does not know')).toHaveLength(2)

  const failing = (): Promise<never> => Promise.reject(new Error('database is locked'))
  await expect(guard(failing, starting('Read', { file_path: '/Users/me/x' }), undefined, log)).resolves.toEqual(
    DENIED(SANDBOX_CHECK_FAILED),
  )
  const throwing = (): never => {
    throw new Error('no session')
  }
  await expect(guard(throwing, starting('Read', { file_path: '/Users/me/x' }), undefined, log)).resolves.toEqual(
    DENIED(SANDBOX_CHECK_FAILED),
  )
  expect(log.withMessage('failed to check a tool call against the sandbox')).toEqual([
    expect.objectContaining({ level: LogLevel.Error }),
    expect.objectContaining({ level: LogLevel.Error }),
  ])
  expect(SANDBOX_CHECK_FAILED).toContain('did not run')
})

it('decides through the session’s own hooks, as the SDK calls them', async () => {
  const onToolStarting = vi.fn<NonNullable<SessionHooks['onToolStarting']>>(() =>
    Promise.resolve({ behavior: ToolPermissionBehavior.Deny, message: 'Not that folder.', byUser: true }),
  )
  const hooks = sdkHooks({ ...handlers(), onToolStarting })
  const [, bounded] = hooks.PreToolUse ?? []
  const [hook] = bounded?.hooks ?? []
  if (hook === undefined) throw new Error('no sandbox hook')

  const output = await hook(starting('Edit', { file_path: '/Users/me/.zshrc' }), 'toolu_01start', {
    signal: new AbortController().signal,
  })

  expect(output).toEqual(DENIED('Not that folder.'))
  expect(onToolStarting).toHaveBeenCalledOnce()
})
