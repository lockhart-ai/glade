// The SDK adapter's sandbox plumbing (`docs/sdk-notes.md` §15), with the SDK's `query()` replaced: the sandbox and
// permissions a session starts with, `applyFlagSettings` on a live one, and the `Bash` hooks that hold the turn.
import type { HookInput, Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { beforeEach, expect, it, vi } from 'vitest'
import { Effort, PermissionMode } from '../../shared/domain'
import { LogLevel, LogScope } from '../logging/logger'
import { createMemoryLog } from '../logging/memory-sink'
import {
  PromptVerdict,
  type AgentSessionOptions,
  type BashCallFinished,
  type BashFinishedAnswer,
  type SandboxFlagSettings,
  type SessionHooks,
} from './backend'
import {
  BASH_FINISHED_TIMEOUT_S,
  createSdkBackend,
  isSandboxed,
  sdkFlagSettings,
  sdkHooks,
  sdkOptions,
  sdkPermissionMode,
  sdkSandbox,
} from './sdk-backend'
import { sandboxStartSettings } from './sandbox'

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
  sandboxed.configure({ model: OPTIONS.model, effort: OPTIONS.effort, permissionMode: PermissionMode.AllowAll })
  sandboxed.configure({ model: OPTIONS.model, effort: OPTIONS.effort, permissionMode: PermissionMode.AskBeforeEdits })
  await settle()
  await settle()
  expect(sdk.session.setPermissionMode.mock.calls).toEqual([['acceptEdits'], ['default']])

  sdk.session.setPermissionMode.mockClear()
  const plain = createSdkBackend({ version: '1.2.3', env: Promise.resolve({}) }).start({
    ...OPTIONS,
    permissionMode: PermissionMode.AskBeforeEdits,
  })
  plain.configure({ model: OPTIONS.model, effort: OPTIONS.effort, permissionMode: PermissionMode.AllowAll })
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
  const hooked = { matcher: 'Bash', hooks: [expect.any(Function)], timeout: BASH_FINISHED_TIMEOUT_S }
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
