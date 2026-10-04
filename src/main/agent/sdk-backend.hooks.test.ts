// The SDK hooks that tell the runner what a session's watchers do (`docs/sdk-notes.md` §13), given the inputs the SDK
// was probed to call them with.
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { expect, it, vi } from 'vitest'
import { CompactionTrigger, Effort, PermissionMode } from '../../shared/domain'
import { LogLevel } from '../logging/logger'
import { createMemoryLog } from '../logging/memory-sink'
import { CONTROL_SERVER_NAME } from '../../shared/control'
import { PromptVerdict, type AgentSessionOptions, type SessionHooks } from './backend'
import { ACCESS_TOOL_NAME, GLADE_SERVER } from './glade-tools'
import { BLOCKED_PROMPT_REASON, SUBAGENT_TOOL_REFUSAL, sdkHooks, sdkOptions } from './sdk-backend'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }))

const OPTIONS: AgentSessionOptions = {
  cwd: '/code/acme-api',
  model: 'claude-sample-1',
  effort: Effort.High,
  permissionMode: PermissionMode.AllowAll,
  resumeSessionId: null,
  systemPromptAppend: 'You are running inside Glade.',
  mcpServers: {},
}

/** What the SDK passes every hook, as the probe saw it. */
const BASE = { session_id: 's1', transcript_path: '/tmp/s1.jsonl', cwd: '/code/acme-api', permission_mode: 'default' }

function promptInput(prompt: string): HookInput {
  return { ...BASE, hook_event_name: 'UserPromptSubmit', prompt_id: 'p1', prompt } as unknown as HookInput
}

function stopInput(crons: unknown): HookInput {
  return {
    ...BASE,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    background_tasks: [],
    session_crons: crons,
  } as HookInput
}

function postCompactInput(trigger: string, summary: unknown): HookInput {
  return { ...BASE, hook_event_name: 'PostCompact', trigger, compact_summary: summary } as HookInput
}

/** Calls the one hook registered for an event, as the SDK does. */
function call(
  hooks: ReturnType<typeof sdkHooks>,
  event: 'UserPromptSubmit' | 'Stop' | 'PostCompact',
  input: HookInput,
) {
  const [matcher] = hooks[event] ?? []
  const [hook] = matcher?.hooks ?? []
  if (hook === undefined) throw new Error(`no ${event} hook`)
  return hook(input, undefined, { signal: new AbortController().signal })
}

function handlers(overrides: Partial<SessionHooks> = {}): SessionHooks {
  return { onPrompt: vi.fn(() => PromptVerdict.Allow), onTurnEnded: vi.fn(), onCompacted: vi.fn(), ...overrides }
}

it('always gives the SDK the subagent tool guard, and the rest only when the session has some to tell', () => {
  expect(Object.keys(sdkOptions(OPTIONS, {}).hooks ?? {})).toEqual(['PreToolUse'])
  const options = sdkOptions({ ...OPTIONS, hooks: handlers() }, {})
  expect(Object.keys(options.hooks ?? {})).toEqual(['PreToolUse', 'UserPromptSubmit', 'Stop', 'PostCompact'])
})

it('asks about each prompt, letting it through or turning it away with the reason', async () => {
  const onPrompt = vi.fn((prompt: string) =>
    prompt === 'Check the queue.' ? PromptVerdict.Block : PromptVerdict.Allow,
  )
  const log = createMemoryLog()
  const hooks = sdkHooks(handlers({ onPrompt }), log.logger)

  await expect(call(hooks, 'UserPromptSubmit', promptInput('Fix the test.'))).resolves.toEqual({})
  await expect(call(hooks, 'UserPromptSubmit', promptInput('Check the queue.'))).resolves.toEqual({
    decision: 'block',
    reason: BLOCKED_PROMPT_REASON,
  })
  expect(onPrompt.mock.calls).toEqual([['Fix the test.'], ['Check the queue.']])
  expect(log.withMessage('prompt turned away')).toMatchObject([{ fields: { prompt: 'Check the queue.' } }])
})

it('lets a prompt through when it can’t read the input, or deciding fails', async () => {
  const log = createMemoryLog()
  const onPrompt = vi.fn(() => {
    throw new Error('the database is gone')
  })
  const hooks = sdkHooks(handlers({ onPrompt }), log.logger)
  await expect(call(hooks, 'UserPromptSubmit', { ...BASE } as unknown as HookInput)).resolves.toEqual({})
  expect(onPrompt).not.toHaveBeenCalled()
  await expect(call(hooks, 'UserPromptSubmit', promptInput('Hi'))).resolves.toEqual({})
  expect(log.withMessage('failed to check a prompt')).toMatchObject([{ level: LogLevel.Error }])
})

it('tells the jobs the session lists as each turn ends, skipping any it can’t read', async () => {
  const onTurnEnded = vi.fn()
  const log = createMemoryLog()
  const hooks = sdkHooks(handlers({ onTurnEnded }), log.logger)
  const crons = [
    { id: 'f4f53242', schedule: '2 19 * * *', recurring: false, prompt: 'Reply with exactly: WOKE UP' },
    { id: 'bad', schedule: '* * * * *' },
    { id: '56a9acf7', schedule: '* * * * *', recurring: true, prompt: 'Reply with exactly: CRON TICK', extra: 1 },
  ]

  await expect(call(hooks, 'Stop', stopInput(crons))).resolves.toEqual({})
  expect(onTurnEnded).toHaveBeenLastCalledWith([
    { id: 'f4f53242', schedule: '2 19 * * *', recurring: false, prompt: 'Reply with exactly: WOKE UP' },
    { id: '56a9acf7', schedule: '* * * * *', recurring: true, prompt: 'Reply with exactly: CRON TICK' },
  ])
  expect(log.withMessage('ignored a scheduled job of a shape Glade does not know')).toHaveLength(1)

  // An older SDK that lists none, or a list of the wrong shape, is as good as none.
  await call(hooks, 'Stop', { ...BASE, hook_event_name: 'Stop', stop_hook_active: false })
  expect(onTurnEnded).toHaveBeenLastCalledWith([])
  await call(hooks, 'Stop', stopInput('nonsense'))
  expect(onTurnEnded).toHaveBeenLastCalledWith([])
  await call(hooks, 'Stop', 42 as unknown as HookInput)
  expect(onTurnEnded).toHaveBeenLastCalledWith([])
})

it('logs a failure to take the jobs in, and carries on', async () => {
  const log = createMemoryLog()
  const hooks = sdkHooks(
    handlers({
      onTurnEnded: () => {
        throw new Error('the database is gone')
      },
    }),
    log.logger,
  )
  await expect(call(hooks, 'Stop', stopInput([]))).resolves.toEqual({})
  expect(log.withMessage('failed to read the scheduled jobs')).toHaveLength(1)
  // With no logger of its own, it logs nowhere.
  await expect(call(sdkHooks(handlers()), 'Stop', stopInput([]))).resolves.toEqual({})
})

it('tells the summary each compaction wrote, manual or automatic, empty ones included', async () => {
  const onCompacted = vi.fn()
  const hooks = sdkHooks(handlers({ onCompacted }))
  const written = '<analysis>\nBrief.\n</analysis>\n\n<summary>\n1. Primary Request and Intent: …\n</summary>'

  await expect(call(hooks, 'PostCompact', postCompactInput('manual', written))).resolves.toEqual({})
  await call(hooks, 'PostCompact', postCompactInput('auto', ''))

  expect(onCompacted.mock.calls).toEqual([
    [{ trigger: CompactionTrigger.Manual, summary: written }],
    [{ trigger: CompactionTrigger.Auto, summary: '' }],
  ])
})

it('ignores a compaction summary it can’t read, and logs a failure to keep one', async () => {
  const log = createMemoryLog()
  const onCompacted = vi.fn()
  const hooks = sdkHooks(handlers({ onCompacted }), log.logger)
  await expect(call(hooks, 'PostCompact', postCompactInput('sometimes', 'Brief.'))).resolves.toEqual({})
  await call(hooks, 'PostCompact', postCompactInput('manual', 42))
  expect(onCompacted).not.toHaveBeenCalled()
  expect(log.withMessage('ignored a compaction summary of a shape Glade does not know')).toHaveLength(2)

  const failing = sdkHooks(
    handlers({
      onCompacted: () => {
        throw new Error('the database is gone')
      },
    }),
    log.logger,
  )
  await expect(call(failing, 'PostCompact', postCompactInput('manual', 'Brief.'))).resolves.toEqual({})
  expect(log.withMessage('failed to keep a compaction summary')).toMatchObject([{ level: LogLevel.Error }])
})

/** A `PreToolUse` input for a `Bash` call, as the SDK gives it (a subagent's has its `agent_id`). */
function bashInput(command: string, overrides: Record<string, unknown> = {}): HookInput {
  return {
    ...BASE,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command, description: 'Commit the fix' },
    tool_use_id: 'toolu_bash',
    ...overrides,
  } as unknown as HookInput
}

/** Calls the `PreToolUse` hook matched to `Bash`, alongside the subagent tool guard every session gets. */
function callBash(hooks: ReturnType<typeof sdkHooks>, input: HookInput) {
  const matcher = (hooks.PreToolUse ?? []).find((entry) => entry.matcher === 'Bash')
  const [hook] = matcher?.hooks ?? []
  if (hook === undefined) throw new Error('no PreToolUse hook for Bash')
  return hook(input, 'toolu_bash', { signal: new AbortController().signal })
}

it('asks about each Bash call before it runs, only when the session wants to know, and waits for the answer', async () => {
  // The subagent tool guard is always there; without `onBashStarting` it's the only `PreToolUse` matcher.
  expect(sdkHooks(handlers()).PreToolUse).toHaveLength(1)
  let finish = (): void => undefined
  const onBashStarting = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const hooks = sdkHooks(handlers({ onBashStarting }))
  expect(hooks.PreToolUse?.map((entry) => entry.matcher)).toEqual([undefined, 'Bash'])

  let answered = false
  const answer = callBash(hooks, bashInput('git commit -m "Fix"', { cwd: '/code/acme-api-docs', agent_id: 'a1' })).then(
    (output) => {
      answered = true
      return output
    },
  )
  await Promise.resolve()
  expect(answered).toBe(false)
  expect(onBashStarting).toHaveBeenCalledExactlyOnceWith({
    toolUseId: 'toolu_bash',
    cwd: '/code/acme-api-docs',
    command: 'git commit -m "Fix"',
  })
  finish()
  await expect(answer).resolves.toEqual({})
})

it('lets a Bash call run anyway when its input can’t be read, telling nothing, or when the answer fails or is slow', async () => {
  vi.useFakeTimers()
  try {
    const log = createMemoryLog()
    const slow = vi.fn(() => new Promise<void>(() => undefined))
    const hooks = sdkHooks(handlers({ onBashStarting: slow }), log.logger, 50)
    await expect(callBash(hooks, bashInput('ls', { tool_input: { description: 'no command' } }))).resolves.toEqual({})
    expect(slow).not.toHaveBeenCalled()

    const waiting = callBash(hooks, bashInput('npm test'))
    await vi.advanceTimersByTimeAsync(50)
    await expect(waiting).resolves.toEqual({})
    expect(log.withMessage('ran a Bash call without waiting any longer for its hook')).toMatchObject([
      { level: LogLevel.Warn, fields: { toolUseId: 'toolu_bash' } },
    ])

    const failing = sdkHooks(handlers({ onBashStarting: () => Promise.reject(new Error('git is gone')) }), log.logger)
    await expect(callBash(failing, bashInput('git commit'))).resolves.toEqual({})
    expect(log.withMessage('failed to note a Bash call')).toMatchObject([{ level: LogLevel.Error }])
  } finally {
    vi.useRealTimers()
  }
})

/** A `PreToolUse` input for an MCP tool call, as the SDK gives it (`mcp_server` only for `mcp__*` tools). */
function mcpInput(
  toolName: string,
  mcpServer: { name: string; source: string } | undefined,
  overrides: Record<string, unknown> = {},
): HookInput {
  return {
    ...BASE,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: {},
    tool_use_id: 'toolu_glade',
    ...(mcpServer === undefined ? {} : { mcp_server: mcpServer }),
    ...overrides,
  } as unknown as HookInput
}

const DENIED = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: SUBAGENT_TOOL_REFUSAL,
  },
}

/** Calls the subagent tool guard: the `PreToolUse` matcher with no `matcher` pattern, every session's first. */
function callGuard(hooks: ReturnType<typeof sdkHooks>, input: HookInput) {
  const [guard] = hooks.PreToolUse ?? []
  const [hook] = guard?.hooks ?? []
  if (hook === undefined) throw new Error('no subagent tool guard')
  return hook(input, 'toolu_glade', { signal: new AbortController().signal })
}

it("refuses a subagent's call to any glade or glade-control tool, whatever its name, before canUseTool could", async () => {
  const log = createMemoryLog()
  const hooks = sdkHooks(undefined, log.logger)

  // The main agent's own calls (no agent_id) run, glade's and glade-control's, `add_artifact` included.
  await expect(
    callGuard(hooks, mcpInput(`mcp__${GLADE_SERVER}__set_status`, { name: GLADE_SERVER, source: 'sdk' })),
  ).resolves.toEqual({})
  await expect(
    callGuard(hooks, mcpInput(`mcp__${CONTROL_SERVER_NAME}__list_tasks`, { name: CONTROL_SERVER_NAME, source: 'sdk' })),
  ).resolves.toEqual({})

  // A subagent's call to any glade tool is refused, `add_artifact` included: the whole server is off limits, not
  // just the user-facing tools (#366).
  await expect(
    callGuard(
      hooks,
      mcpInput(`mcp__${GLADE_SERVER}__ask`, { name: GLADE_SERVER, source: 'sdk' }, { agent_id: 'sub-1' }),
    ),
  ).resolves.toEqual(DENIED)
  await expect(
    callGuard(
      hooks,
      mcpInput(`mcp__${GLADE_SERVER}__add_artifact`, { name: GLADE_SERVER, source: 'sdk' }, { agent_id: 'sub-1' }),
    ),
  ).resolves.toEqual(DENIED)
  expect(log.withMessage("refused a subagent's call to one of Glade's own tools")).toMatchObject([
    { fields: { toolName: `mcp__${GLADE_SERVER}__ask`, server: GLADE_SERVER, agentId: 'sub-1' } },
    { fields: { toolName: `mcp__${GLADE_SERVER}__add_artifact`, server: GLADE_SERVER, agentId: 'sub-1' } },
  ])

  // A subagent's call to glade-control, the control API (P13-01), is refused too: it's reachable the same way,
  // inherited from the main agent with no tool restriction of its own.
  await expect(
    callGuard(
      hooks,
      mcpInput(
        `mcp__${CONTROL_SERVER_NAME}__create_task`,
        { name: CONTROL_SERVER_NAME, source: 'sdk' },
        { agent_id: 'sub-1' },
      ),
    ),
  ).resolves.toEqual(DENIED)

  // A subagent's other tools, MCP or not, are untouched.
  await expect(
    callGuard(hooks, mcpInput('Bash', undefined, { agent_id: 'sub-1', tool_input: { command: 'ls' } })),
  ).resolves.toEqual({})
  await expect(
    callGuard(hooks, mcpInput('mcp__github__create_issue', { name: 'github', source: 'user' }, { agent_id: 'sub-1' })),
  ).resolves.toEqual({})

  // A configured server pretending to be named `glade` isn't trusted: only `source: 'sdk'` is, per the SDK's own
  // guidance to key trust decisions on it, never on the name (`docs/sdk-notes.md` §9).
  await expect(
    callGuard(
      hooks,
      mcpInput(`mcp__${GLADE_SERVER}__ask`, { name: GLADE_SERVER, source: 'user' }, { agent_id: 'sub-1' }),
    ),
  ).resolves.toEqual({})

  // Input of a shape the SDK isn't documented to give is let through, not decided either way.
  await expect(callGuard(hooks, { ...BASE, hook_event_name: 'PreToolUse' } as unknown as HookInput)).resolves.toEqual(
    {},
  )
})

it("lets a subagent's request_access through, alone of Glade's tools, and tells of each call to it and whose", async () => {
  const log = createMemoryLog()
  const onAccessRequested = vi.fn()
  const hooks = sdkHooks(handlers({ onAccessRequested }), log.logger)
  const glade = { name: GLADE_SERVER, source: 'sdk' }
  const input = { path: '/Users/me/.cache/uv', access: 'write', reason: 'uv needs its cache.' }

  // A subagent's call runs, and so does the main agent's: the hook tells of both, with whose each is.
  await expect(
    callGuard(
      hooks,
      mcpInput(ACCESS_TOOL_NAME, glade, { agent_id: 'sub-1', tool_use_id: 'toolu_a', tool_input: input }),
    ),
  ).resolves.toEqual({})
  await expect(
    callGuard(hooks, mcpInput(ACCESS_TOOL_NAME, glade, { tool_use_id: 'toolu_b', tool_input: input })),
  ).resolves.toEqual({})
  expect(onAccessRequested.mock.calls).toEqual([
    [{ toolUseId: 'toolu_a', agentId: 'sub-1', input }],
    [{ toolUseId: 'toolu_b', agentId: null, input }],
  ])

  // Every other Glade tool is still refused to a subagent, and so is a control tool of the same name.
  await expect(callGuard(hooks, mcpInput(`mcp__${GLADE_SERVER}__ask`, glade, { agent_id: 'sub-1' }))).resolves.toEqual(
    DENIED,
  )
  await expect(
    callGuard(
      hooks,
      mcpInput(
        `mcp__${CONTROL_SERVER_NAME}__request_access`,
        { name: CONTROL_SERVER_NAME, source: 'sdk' },
        { agent_id: 'sub-1' },
      ),
    ),
  ).resolves.toEqual(DENIED)
  // A configured server's tool of that name isn't Glade's: nothing is told of it.
  await expect(
    callGuard(hooks, mcpInput(ACCESS_TOOL_NAME, { name: GLADE_SERVER, source: 'user' }, { agent_id: 'sub-1' })),
  ).resolves.toEqual({})
  expect(onAccessRequested).toHaveBeenCalledTimes(2)
})

it('lets request_access run whatever the hook can read of the call, or whoever hears of it', async () => {
  const log = createMemoryLog()
  const glade = { name: GLADE_SERVER, source: 'sdk' }
  const onAccessRequested = vi.fn()
  const hooks = sdkHooks(handlers({ onAccessRequested }), log.logger)

  // No id for the call: nothing to tell. Input that isn't an object is told as none.
  await expect(
    callGuard(hooks, mcpInput(ACCESS_TOOL_NAME, glade, { agent_id: 'sub-1', tool_use_id: undefined })),
  ).resolves.toEqual({})
  expect(onAccessRequested).not.toHaveBeenCalled()
  await expect(
    callGuard(hooks, mcpInput(ACCESS_TOOL_NAME, glade, { tool_use_id: 'toolu_c', tool_input: 'nonsense' })),
  ).resolves.toEqual({})
  expect(onAccessRequested).toHaveBeenLastCalledWith({ toolUseId: 'toolu_c', agentId: null, input: {} })

  // A session that doesn't listen (one with the sandbox off), or none, and a listener that throws: the call still runs.
  await expect(
    callGuard(sdkHooks(handlers(), log.logger), mcpInput(ACCESS_TOOL_NAME, glade, { agent_id: 'sub-1' })),
  ).resolves.toEqual({})
  await expect(
    callGuard(sdkHooks(undefined, log.logger), mcpInput(ACCESS_TOOL_NAME, glade, { agent_id: 'sub-1' })),
  ).resolves.toEqual({})
  const failing = sdkHooks(
    handlers({
      onAccessRequested: () => {
        throw new Error('no session')
      },
    }),
    log.logger,
  )
  await expect(callGuard(failing, mcpInput(ACCESS_TOOL_NAME, glade, {}))).resolves.toEqual({})
  expect(log.withMessage('failed to note a request_access call')).toHaveLength(1)
})
