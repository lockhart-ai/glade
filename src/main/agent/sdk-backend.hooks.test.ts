// The SDK hooks that tell the runner what a session's watchers do (`docs/sdk-notes.md` §13), given the inputs the SDK
// was probed to call them with.
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { expect, it, vi } from 'vitest'
import { CompactionTrigger, Effort, PermissionMode } from '../../shared/domain'
import { LogLevel } from '../logging/logger'
import { createMemoryLog } from '../logging/memory-sink'
import { PromptVerdict, type AgentSessionOptions, type SessionHooks } from './backend'
import { BLOCKED_PROMPT_REASON, sdkHooks, sdkOptions } from './sdk-backend'

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

it('gives the SDK the hooks only when the session has some to tell', () => {
  expect(sdkOptions(OPTIONS, {})).not.toHaveProperty('hooks')
  const options = sdkOptions({ ...OPTIONS, hooks: handlers() }, {})
  expect(Object.keys(options.hooks ?? {})).toEqual(['UserPromptSubmit', 'Stop', 'PostCompact'])
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

/** Calls the `PreToolUse` hook, checking it's only for `Bash`. */
function callBash(hooks: ReturnType<typeof sdkHooks>, input: HookInput) {
  const [matcher] = hooks.PreToolUse ?? []
  expect(matcher?.matcher).toBe('Bash')
  const [hook] = matcher?.hooks ?? []
  if (hook === undefined) throw new Error('no PreToolUse hook')
  return hook(input, 'toolu_bash', { signal: new AbortController().signal })
}

it('asks about each Bash call before it runs, only when the session wants to know, and waits for the answer', async () => {
  expect(Object.keys(sdkHooks(handlers()))).toEqual(['UserPromptSubmit', 'Stop', 'PostCompact'])
  let finish = (): void => undefined
  const onBashStarting = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const hooks = sdkHooks(handlers({ onBashStarting }))
  expect(Object.keys(hooks)).toEqual(['UserPromptSubmit', 'Stop', 'PostCompact', 'PreToolUse'])

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
