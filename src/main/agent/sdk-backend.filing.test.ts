// The SDK hooks a session with the todo hub gets (P16-04, #495; `docs/sdk-notes.md` §16), given the inputs #492's
// probes saw the SDK call them with: `PreToolUse` on the tools that make a child, `PostToolBatch`, and `Stop`, which
// can hold the end of a turn. And the setting that keeps Claude Code's task tools on.
import type { HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk'
import { expect, it, vi } from 'vitest'
import { Effort, PermissionMode, type ToolInput } from '../../shared/domain'
import { LogLevel } from '../logging/logger'
import { createMemoryLog } from '../logging/memory-sink'
import { PromptVerdict, type AgentSessionOptions, type SessionHooks } from './backend'
import {
  CHILD_TOOLS,
  childCallHook,
  COMMAND_TOOLS,
  responseText,
  sdkHooks,
  sdkOptions,
  TASK_TOOLS_ENV,
  toolBatchHook,
} from './sdk-backend'

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

const SIGNAL = { signal: new AbortController().signal }

function handlers(overrides: Partial<SessionHooks> = {}): SessionHooks {
  return { onPrompt: vi.fn(() => PromptVerdict.Allow), onTurnEnded: vi.fn(), onCompacted: vi.fn(), ...overrides }
}

/** What the todo hub's three hooks are, each answering as a test says. */
function hubHandlers(overrides: Partial<SessionHooks> = {}): SessionHooks {
  return handlers({
    onChildStarting: vi.fn(() => Promise.resolve(null)),
    onBatchFinished: vi.fn(() => Promise.resolve(null)),
    onTurnEnding: vi.fn(() => Promise.resolve(null)),
    ...overrides,
  })
}

function preToolUse(toolName: string, input: unknown, extra: Record<string, unknown> = {}): HookInput {
  return {
    ...BASE,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: input,
    tool_use_id: 'toolu_1',
    ...extra,
  } as unknown as HookInput
}

function batch(calls: unknown, extra: Record<string, unknown> = {}): HookInput {
  return { ...BASE, hook_event_name: 'PostToolBatch', tool_calls: calls, ...extra } as unknown as HookInput
}

function stop(extra: Record<string, unknown> = {}): HookInput {
  return {
    ...BASE,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    background_tasks: [],
    session_crons: [],
    ...extra,
  } as unknown as HookInput
}

/** Calls every `PreToolUse` hook whose matcher takes the tool, as Claude Code does, and answers what each said. */
function callPreToolUse(hooks: ReturnType<typeof sdkHooks>, input: HookInput): Promise<HookJSONOutput[]> {
  const toolName = (input as { tool_name: string }).tool_name
  const matching = (hooks.PreToolUse ?? []).filter(
    ({ matcher }) => matcher === undefined || new RegExp(`^(${matcher})$`).test(toolName),
  )
  return Promise.all(
    matching.flatMap(({ hooks: callbacks }) => callbacks.map((hook) => hook(input, 'toolu_1', SIGNAL))),
  )
}

function callOnly(hooks: ReturnType<typeof sdkHooks>, event: 'PostToolBatch' | 'Stop', input: HookInput) {
  const [hook] = hooks[event]?.[0]?.hooks ?? []
  if (hook === undefined) throw new Error(`no ${event} hook`)
  return hook(input, undefined, SIGNAL)
}

it('gives a session with the todo hub its three hooks, and any other session exactly the hooks it had', () => {
  const before = sdkHooks(handlers())
  expect(Object.keys(before)).toEqual(['PreToolUse', 'UserPromptSubmit', 'Stop', 'PostCompact'])
  expect(before.PreToolUse?.map(({ matcher }) => matcher)).toEqual([undefined])

  const hub = sdkHooks(hubHandlers())
  expect(Object.keys(hub)).toEqual(['PreToolUse', 'UserPromptSubmit', 'Stop', 'PostCompact', 'PostToolBatch'])
  expect(hub.PreToolUse?.map(({ matcher }) => matcher)).toEqual([undefined, CHILD_TOOLS])
  expect(CHILD_TOOLS).toBe('Agent|Monitor|Bash|ScheduleWakeup|CronCreate')
  // Every message's calls, whatever the tools: no matcher.
  expect(hub.PostToolBatch).toMatchObject([{ hooks: [expect.any(Function)] }])
  expect(hub.PostToolBatch?.[0]?.matcher).toBeUndefined()
  // Alongside the hooks a session that watches its commands has.
  const both = sdkHooks(hubHandlers({ onBashStarting: () => Promise.resolve() }))
  expect(both.PreToolUse?.map(({ matcher }) => matcher)).toEqual([undefined, 'Bash', CHILD_TOOLS])
  expect(COMMAND_TOOLS).toBe('Bash|Monitor')
})

it('hands a call that names its todo the input without the marker, the whole of it, and never decides the call', async () => {
  const written = { description: '[todo 2] CI checks on PR #42', timeout_ms: 1_800_000, command: 'gh pr checks 42' }
  const ran: ToolInput = { ...written, description: 'CI checks on PR #42' }
  const onChildStarting = vi.fn(() => Promise.resolve<ToolInput | null>(ran))
  const hooks = sdkHooks(hubHandlers({ onChildStarting }))

  const answers = await callPreToolUse(hooks, preToolUse('Monitor', written))

  expect(onChildStarting).toHaveBeenCalledExactlyOnceWith({ toolName: 'Monitor', input: written, toolUseId: 'toolu_1' })
  // The guard for Glade's own tools has nothing to say of it; the hub's hook hands back the input alone.
  expect(answers).toEqual([{}, { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: ran } }])
  // No decision, ever: an `allow` here would run the call in the ask mode without asking (sdk-notes §16).
  for (const answer of answers) {
    expect(JSON.stringify(answer)).not.toMatch(/permissionDecision|"decision"|allow|deny/)
  }
  // A copy, since the SDK may change what it's handed.
  const [, { hookSpecificOutput }] = answers as [unknown, { hookSpecificOutput: { updatedInput: ToolInput } }]
  expect(hookSpecificOutput.updatedInput).not.toBe(ran)
})

it('leaves a call with no marker as the model wrote it', async () => {
  const onChildStarting = vi.fn(() => Promise.resolve(null))
  const hooks = sdkHooks(hubHandlers({ onChildStarting }))

  for (const tool of ['Agent', 'Monitor', 'Bash', 'ScheduleWakeup', 'CronCreate']) {
    await expect(callPreToolUse(hooks, preToolUse(tool, { description: 'Review the date helpers' }))).resolves.toEqual([
      {},
      {},
    ])
  }
  expect(onChildStarting).toHaveBeenCalledTimes(5)
})

it('never touches a subagent’s call, a marker in it included, or a tool that makes no child', async () => {
  const onChildStarting = vi.fn(() => Promise.resolve<ToolInput | null>({ description: 'never used' }))
  const hook = childCallHook(onChildStarting)
  const marked = { description: '[todo 2] Run the tests', command: 'npm test', run_in_background: true }

  // A subagent's call, at any depth, carries the id of the subagent that made it.
  await expect(
    hook(preToolUse('Bash', marked, { agent_id: 'aa75', agent_type: 'general-purpose' }), 'x', SIGNAL),
  ).resolves.toEqual({})
  await expect(hook(preToolUse('Agent', marked, { agent_id: 'a236' }), 'x', SIGNAL)).resolves.toEqual({})
  // The matcher can match more than the names it lists: another server's tool is none of these.
  await expect(hook(preToolUse('mcp__shell__Bash', marked), 'x', SIGNAL)).resolves.toEqual({})
  await expect(hook(preToolUse('Read', { file_path: 'a.ts' }), 'x', SIGNAL)).resolves.toEqual({})

  expect(onChildStarting).not.toHaveBeenCalled()
})

it('runs a call as written when it can’t read the input, or the host fails', async () => {
  const log = createMemoryLog()
  const onChildStarting = vi.fn(() => Promise.reject(new Error('the database is gone')))
  const hook = childCallHook(onChildStarting, log.logger)

  await expect(hook({ ...BASE, hook_event_name: 'PreToolUse' } as unknown as HookInput, 'x', SIGNAL)).resolves.toEqual(
    {},
  )
  await expect(hook(preToolUse('Bash', 'not an object'), 'x', SIGNAL)).resolves.toEqual({})
  expect(onChildStarting).not.toHaveBeenCalled()

  await expect(hook(preToolUse('Bash', { command: 'ls' }), 'x', SIGNAL)).resolves.toEqual({})
  expect(log.withMessage('failed to read the todo a call names')).toMatchObject([
    { level: LogLevel.Error, fields: { toolName: 'Bash', toolUseId: 'toolu_1' } },
  ])
})

it('tells the host of a message’s calls once they have run, and adds what it answers to their results', async () => {
  const told = 'Glade: file what you just made under its todo now.'
  const onBatchFinished = vi.fn<NonNullable<SessionHooks['onBatchFinished']>>(() => Promise.resolve(told))
  const hooks = sdkHooks(hubHandlers({ onBatchFinished }))
  const calls = [
    {
      tool_name: 'Agent',
      tool_input: { description: 'Review src/dates.js', prompt: 'Review it.' },
      tool_use_id: 'toolu_a',
      tool_response: 'Async agent launched successfully.',
    },
    {
      tool_name: 'Bash',
      tool_input: { command: 'git commit -am "Fix"' },
      tool_use_id: 'toolu_b',
      tool_response: { stdout: '[main abc1234] Fix', stderr: 'warning: LF will be replaced', interrupted: false },
    },
    {
      tool_name: 'mcp__glade__set_status',
      tool_input: { status: 'Reviewing.' },
      tool_use_id: 'toolu_c',
      tool_response: [{ type: 'text', text: 'Status updated.' }],
    },
    // Of a shape Glade doesn't know: left out. One with no input or result still counts.
    { tool_name: 'Read' },
    { tool_name: 'TaskStop', tool_use_id: 'toolu_d', tool_input: 'gone' },
  ]

  await expect(callOnly(hooks, 'PostToolBatch', batch(calls))).resolves.toEqual({
    hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: told },
  })

  expect(onBatchFinished).toHaveBeenCalledExactlyOnceWith({
    calls: [
      {
        toolName: 'Agent',
        toolUseId: 'toolu_a',
        input: { description: 'Review src/dates.js', prompt: 'Review it.' },
        output: 'Async agent launched successfully.',
      },
      {
        toolName: 'Bash',
        toolUseId: 'toolu_b',
        input: { command: 'git commit -am "Fix"' },
        output: '[main abc1234] Fix\nwarning: LF will be replaced',
      },
      {
        toolName: 'mcp__glade__set_status',
        toolUseId: 'toolu_c',
        input: { status: 'Reviewing.' },
        output: 'Status updated.',
      },
      { toolName: 'TaskStop', toolUseId: 'toolu_d', input: {}, output: '' },
    ],
  })
})

it('adds nothing to a message whose calls made nothing to file, and never answers a subagent’s message', async () => {
  const onBatchFinished = vi.fn(() => Promise.resolve<string | null>(null))
  const hooks = sdkHooks(hubHandlers({ onBatchFinished }))
  const calls = [{ tool_name: 'Read', tool_input: { file_path: 'a.ts' }, tool_use_id: 'toolu_r', tool_response: '…' }]

  await expect(callOnly(hooks, 'PostToolBatch', batch(calls))).resolves.toEqual({})
  expect(onBatchFinished).toHaveBeenCalledTimes(1)

  // It fires for a subagent's messages too: context answered to one of those would go to that subagent.
  onBatchFinished.mockResolvedValue('Glade: file what you just made.')
  await expect(callOnly(hooks, 'PostToolBatch', batch(calls, { agent_id: 'aa75' }))).resolves.toEqual({})
  expect(onBatchFinished).toHaveBeenCalledTimes(1)
})

it('adds nothing when it can’t read a message’s calls, or the host fails', async () => {
  const log = createMemoryLog()
  const onBatchFinished = vi.fn(() => Promise.reject(new Error('the database is gone')))
  const hook = toolBatchHook(onBatchFinished, log.logger)

  await expect(hook(batch('not a list'), undefined, SIGNAL)).resolves.toEqual({})
  expect(onBatchFinished).not.toHaveBeenCalled()
  await expect(hook(batch([]), undefined, SIGNAL)).resolves.toEqual({})
  expect(log.withMessage("failed to note a message's tool calls")).toMatchObject([{ level: LogLevel.Error }])
})

it('reads a call’s result as text, however the hook gives it', () => {
  expect(responseText('Monitor started (task bm7c2x1).')).toBe('Monitor started (task bm7c2x1).')
  expect(responseText({ stdout: '[main abc1234] Fix', stderr: '' })).toBe('[main abc1234] Fix')
  expect(responseText({ stdout: 7, stderr: 'fatal: not a git repository' })).toBe('fatal: not a git repository')
  expect(
    responseText([
      { type: 'text', text: 'Filed 1 child:' },
      { type: 'text', text: 'c1 under #2.' },
    ]),
  ).toBe('Filed 1 child:\nc1 under #2.')
  // Anything else says nothing Glade reads.
  expect(responseText({ taskId: 'bm7c2x1', timeoutMs: 1_800_000 })).toBe('')
  expect(responseText([{ type: 'image', source: {} }])).toBe('')
  expect(responseText(undefined)).toBe('')
  expect(responseText(null)).toBe('')
  expect(responseText(42)).toBe('')
})

it('holds the end of a turn for as long as the host says why, after telling it the jobs, and says whether it was held', async () => {
  const log = createMemoryLog()
  const reason = "Glade: these aren't filed under a todo yet."
  const onTurnEnded = vi.fn()
  const onTurnEnding = vi
    .fn<NonNullable<SessionHooks['onTurnEnding']>>()
    .mockResolvedValueOnce(reason)
    .mockResolvedValueOnce(reason)
    .mockResolvedValue(null)
  const hooks = sdkHooks(hubHandlers({ onTurnEnded, onTurnEnding }), log.logger)
  const crons = [{ id: '56a9acf7', schedule: '* * * * *', recurring: true, prompt: 'Check the queue.' }]

  await expect(callOnly(hooks, 'Stop', stop({ session_crons: crons }))).resolves.toEqual({ decision: 'block', reason })
  await expect(callOnly(hooks, 'Stop', stop({ stop_hook_active: true }))).resolves.toEqual({
    decision: 'block',
    reason,
  })
  await expect(callOnly(hooks, 'Stop', stop({ stop_hook_active: true }))).resolves.toEqual({})

  expect(onTurnEnding.mock.calls).toEqual([[{ held: false }], [{ held: true }], [{ held: true }]])
  // The jobs are told each time, held or not.
  expect(onTurnEnded.mock.calls).toEqual([[crons], [[]], [[]]])
  expect(log.withMessage('turn end held').map(({ fields }) => fields.held)).toEqual([false, true])
})

it('lets a turn end when the host fails, when it can’t tell whose turn it is, and for a session without the hub', async () => {
  const log = createMemoryLog()
  const onTurnEnding = vi.fn(() => Promise.reject(new Error('the database is gone')))
  const hooks = sdkHooks(hubHandlers({ onTurnEnding }), log.logger)

  await expect(callOnly(hooks, 'Stop', stop())).resolves.toEqual({})
  expect(log.withMessage('failed to decide whether a turn may end')).toMatchObject([{ level: LogLevel.Error }])
  // Only the agent's own turn is ever held.
  await expect(callOnly(hooks, 'Stop', stop({ agent_id: 'aa75' }))).resolves.toEqual({})
  await expect(callOnly(hooks, 'Stop', 'not an object' as unknown as HookInput)).resolves.toEqual({})
  expect(onTurnEnding).toHaveBeenCalledTimes(1)
  // What it can't read of whether the turn was held counts as not held.
  onTurnEnding.mockResolvedValue(null as never)
  await callOnly(hooks, 'Stop', stop({ stop_hook_active: 'yes' }))
  expect(onTurnEnding).toHaveBeenLastCalledWith({ held: false })

  // Without the hub's hook, the Stop hook only tells the jobs, as it always has.
  const onTurnEnded = vi.fn()
  await expect(callOnly(sdkHooks(handlers({ onTurnEnded })), 'Stop', stop())).resolves.toEqual({})
  expect(onTurnEnded).toHaveBeenCalledTimes(1)
})

it('keeps Claude Code’s task tools on in the session’s own settings, only when asked to', () => {
  const kept = sdkOptions({ ...OPTIONS, keepTaskTools: true }, { PATH: '/usr/bin' })

  // In the flag settings, which outrank a settings file that turns the tools off (sdk-notes §16, "TodoWrite").
  expect(kept.settings).toEqual({
    deniedMcpServers: [{ serverName: 'glade-control' }],
    env: { CLAUDE_CODE_ENABLE_TASKS: 'true' },
  })
  expect(TASK_TOOLS_ENV).toEqual({ CLAUDE_CODE_ENABLE_TASKS: 'true' })
  // The session's own environment leaves the switch to the user, as before: only the settings force it.
  expect(kept.env).not.toHaveProperty('CLAUDE_CODE_ENABLE_TASKS')
  expect(kept.env).toMatchObject({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' })

  for (const options of [OPTIONS, { ...OPTIONS, keepTaskTools: false }]) {
    expect(sdkOptions(options, {}).settings).toEqual({ deniedMcpServers: [{ serverName: 'glade-control' }] })
  }
  // With the sandbox's rules beside it.
  const sandboxed = sdkOptions(
    { ...OPTIONS, keepTaskTools: true, flagSettings: { permissions: { allow: ['Read(//tmp/notes/**)'] } } },
    {},
  )
  expect(sandboxed.settings).toMatchObject({
    permissions: { allow: ['Read(//tmp/notes/**)'] },
    env: { CLAUDE_CODE_ENABLE_TASKS: 'true' },
  })
})
