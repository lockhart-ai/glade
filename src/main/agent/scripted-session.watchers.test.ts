// The scripted session's watchers (`docs/sdk-notes.md` §13): the background tasks `Monitor` and `Bash` calls start,
// the jobs `ScheduleWakeup` and `CronCreate` schedule, and what their wakes put to the session's hooks, in the shapes
// the SDK was probed to send.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Effort, PermissionMode } from '../../shared/domain'
import { PromptVerdict, type AgentSessionOptions, type SessionHooks, type SessionJob } from './backend'
import { endNotice, eventNotice, ScriptedSession } from './scripted-session'
import { BLOCKED_PROMPT_REASON } from './sdk-backend'
import {
  background,
  delay,
  init,
  result,
  say,
  taskEnd,
  tool,
  toolResult,
  toolUse,
  wake,
  WakeCause,
  type AgentScript,
  type ScriptTurn,
} from './scripts'

const SESSION: AgentSessionOptions = {
  cwd: '/code/acme-api',
  model: 'claude-sample-1',
  effort: Effort.High,
  permissionMode: PermissionMode.AllowAll,
  resumeSessionId: null,
  systemPromptAppend: '',
  mcpServers: {},
}

/** A session on a script, with what it streams, what its hooks were told, and how often it went idle. */
interface Played {
  readonly session: ScriptedSession
  readonly raw: Record<string, unknown>[]
  readonly prompts: string[]
  /** The jobs the `Stop` hook was told of, turn by turn. */
  readonly listed: (readonly SessionJob[])[]
  readonly idles: () => number
}

let ids: number

function play(
  turns: readonly ScriptTurn[],
  options: {
    readonly verdict?: (prompt: string) => PromptVerdict
    readonly resume?: boolean
    readonly hooks?: boolean
  } & Partial<Pick<AgentScript, 'restoredJobs'>> = {},
): Played {
  const prompts: string[] = []
  const listed: (readonly SessionJob[])[] = []
  const hooks: SessionHooks = {
    onPrompt: (prompt) => {
      prompts.push(prompt)
      return options.verdict?.(prompt) ?? PromptVerdict.Allow
    },
    onTurnEnded: (jobs) => {
      listed.push(jobs)
    },
  }
  let idles = 0
  const session = new ScriptedSession({
    script: {
      name: 'test',
      turns,
      ...(options.restoredJobs === undefined ? {} : { restoredJobs: options.restoredJobs }),
    },
    session: {
      ...SESSION,
      ...(options.resume === true ? { resumeSessionId: 'resumed' } : {}),
      ...(options.hooks === false ? {} : { hooks }),
    },
    newId: () => `id-${String((ids += 1))}`,
    onIdle: () => {
      idles += 1
    },
  })
  const raw: Record<string, unknown>[] = []
  void (async () => {
    for await (const message of session.messages) raw.push(message as Record<string, unknown>)
  })()
  return { session, raw, prompts, listed, idles: () => idles }
}

async function flush(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

/** The messages of a type, or a subtype. */
function of(raw: readonly Record<string, unknown>[], kind: string): Record<string, unknown>[] {
  return raw.filter((message) => message.type === kind || message.subtype === kind)
}

/** The texts the agent said, in order. */
function said(raw: readonly Record<string, unknown>[]): string[] {
  return raw.flatMap((message) => {
    if (message.type !== 'assistant') return []
    const { content } = message.message as { content: { type: string; text?: string }[] }
    return content.flatMap((block) => (block.type === 'text' && block.text !== undefined ? [block.text] : []))
  })
}

/** The `tool_use_result` of a call's result. */
function details(raw: readonly Record<string, unknown>[], toolUseId: string): unknown {
  return raw.find((message) => {
    if (message.type !== 'user') return false
    const { content } = message.message as { content: { tool_use_id?: string }[] }
    return content.some((block) => block.tool_use_id === toolUseId)
  })?.tool_use_result
}

const CI = { description: 'CI checks', timeout_ms: 60_000, command: 'gh pr checks 42 --watch' }

beforeEach(() => {
  ids = 0
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 8, 25, 13, 7, 30))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a background task', () => {
  it('starts for a Monitor, or a Bash in the background, and the call’s result names it; a foreground Bash’s isn’t', async () => {
    const played = play([
      [
        init(),
        ...tool('ci', 'Monitor', CI, 'Monitor started.'),
        ...tool('tests', 'Bash', { command: 'npm test', description: 'Tests', run_in_background: true }, 'Running.'),
        ...tool('ls', 'Bash', { command: 'ls' }, 'a.ts'),
        ...tool('bare', 'Monitor', { command: 'x' }, 'Monitor started.'),
        result(),
      ],
    ])
    played.session.send('Go', 'user-1')
    await flush()

    expect(of(played.raw, 'task_started')).toEqual([
      expect.objectContaining({
        task_id: 'bid2w1',
        tool_use_id: 'toolu_id2_1_ci',
        description: 'CI checks',
        is_backgrounded: true,
        task_type: 'local_bash',
      }),
      expect.objectContaining({ task_id: 'bid2w2', tool_use_id: 'toolu_id2_1_tests', description: 'Tests' }),
      // A foreground command runs as a task too, not backgrounded, and ends before its result.
      expect.objectContaining({ task_id: 'bid2f1', tool_use_id: 'toolu_id2_1_ls', is_backgrounded: false }),
      expect.objectContaining({ task_id: 'bid2w3', tool_use_id: 'toolu_id2_1_bare', description: '' }),
    ])
    expect(of(played.raw, 'task_notification')).toEqual([
      expect.objectContaining({ task_id: 'bid2f1', tool_use_id: 'toolu_id2_1_ls', status: 'completed', summary: '' }),
    ])
    expect(details(played.raw, 'toolu_id2_1_ci')).toEqual({ taskId: 'bid2w1', timeoutMs: 60_000, persistent: false })
    expect(details(played.raw, 'toolu_id2_1_tests')).toEqual({
      stdout: '',
      stderr: '',
      interrupted: false,
      noOutputExpected: false,
      backgroundTaskId: 'bid2w2',
    })
    expect(details(played.raw, 'toolu_id2_1_ls')).toEqual({ stdout: 'a.ts', stderr: '', interrupted: false })
    expect(details(played.raw, 'toolu_id2_1_bare')).toEqual({ taskId: 'bid2w3', timeoutMs: 300_000, persistent: false })
  })

  it('wakes the agent for each event and its ending, telling the prompt hook each, as the SDK words them', async () => {
    const played = play([
      [
        init(),
        ...tool('ci', 'Monitor', CI, 'Monitor started.'),
        wake([init(), say('Lint passed.'), result()], {
          cause: WakeCause.MonitorEvent,
          task: 'ci',
          event: 'lint\tpass',
          ms: 10,
        }),
        wake([init(), say('It failed.'), result()], {
          task: 'ci',
          outcome: 'failed',
          summary: 'Monitor "CI checks" script failed (exit 7)',
          event: 'unit\tfail',
          ms: 20,
        }),
        result({ text: 'Watching.' }),
      ],
    ])
    played.session.send('Watch CI', 'user-1')
    await flush(30)

    expect(played.prompts).toEqual([
      eventNotice('bid2w1', 'CI checks', 'lint\tpass'),
      endNotice('bid2w1', 'toolu_id2_1_ci', 'failed', 'Monitor "CI checks" script failed (exit 7)', 'unit\tfail'),
    ])
    expect(of(played.raw, 'task_notification')).toEqual([
      expect.objectContaining({
        task_id: 'bid2w1',
        tool_use_id: 'toolu_id2_1_ci',
        status: 'failed',
        summary: 'Monitor "CI checks" script failed (exit 7)',
      }),
    ])
    expect(of(played.raw, 'task_updated')).toEqual([
      expect.objectContaining({ task_id: 'bid2w1', patch: expect.objectContaining({ status: 'failed' }) as unknown }),
    ])
    expect(said(played.raw)).toEqual(['Lint passed.', 'It failed.'])
    expect(of(played.raw, 'result').map((message) => message.origin)).toEqual([
      undefined,
      { kind: 'task-notification' },
      { kind: 'task-notification' },
    ])
  })

  it('stops with stopTask, as the SDK stops one, and a stopped task never wakes the agent', async () => {
    const played = play([
      [
        init(),
        ...tool('ci', 'Monitor', CI, 'Monitor started.'),
        wake([init(), say('Never.'), result()], { cause: WakeCause.MonitorEvent, task: 'ci', event: 'x', ms: 10 }),
        wake([init(), say('Never either.'), result()], { task: 'ci', summary: 'ended', ms: 20 }),
        result({ text: 'Watching.' }),
      ],
    ])
    played.session.send('Watch CI', 'user-1')
    await flush()
    const idle = played.idles()

    await played.session.stopTask('bid2w1')
    await played.session.stopTask('bid2w1')
    await played.session.stopTask('nope')
    await flush(30)

    expect(of(played.raw, 'task_notification')).toEqual([
      expect.objectContaining({ task_id: 'bid2w1', status: 'stopped', summary: 'CI checks' }),
    ])
    expect(of(played.raw, 'task_updated')).toEqual([
      expect.objectContaining({ patch: expect.objectContaining({ status: 'killed' }) as unknown }),
    ])
    expect(said(played.raw)).toEqual([])
    expect(played.prompts).toEqual([])
    // Each skipped wake still leaves the session idle, as the one it scheduled would have.
    expect(played.idles()).toBe(idle + 2)
  })

  it('a subagent’s starts owned by it, and ends without waking the agent, unless it was stopped (#291)', async () => {
    const played = play([
      [
        init(),
        background(
          'fixer',
          { description: 'Fix the flaky test', prompt: 'Fix it.' },
          [
            ...tool('e2e', 'Bash', { command: 'npm run e2e', run_in_background: true }, 'Running.', 'fixer'),
            ...tool('lint', 'Bash', { command: 'npm run lint', run_in_background: true }, 'Running.', 'fixer'),
            taskEnd('e2e', 'Background command "e2e" failed with exit code 1', 'failed'),
            taskEnd('e2e', 'Twice'),
            delay(10),
            taskEnd('lint', 'Never'),
            taskEnd('nope', 'Never'),
          ],
          { summary: 'Fixed.' },
        ),
        result({ text: 'Started a subagent.' }),
      ],
    ])
    played.session.send('Fix it', 'user-1')
    await flush()
    await played.session.stopTask('bid2w2')
    await flush(20)

    expect(of(played.raw, 'task_started').filter((message) => message.task_type === 'local_bash')).toEqual([
      expect.objectContaining({ task_id: 'bid2w1', is_backgrounded: true, owned_by_subagent: true }),
      expect.objectContaining({ task_id: 'bid2w2', is_backgrounded: true, owned_by_subagent: true }),
    ])
    expect(of(played.raw, 'task_notification').map(({ task_id, status }) => [task_id, status])).toEqual([
      ['bid2w1', 'failed'],
      ['bid2w2', 'stopped'],
      ['aid21', 'completed'],
    ])
    expect(played.prompts).toEqual([])
  })

  it('says nothing once the session is closed', async () => {
    const played = play([[init(), ...tool('ci', 'Monitor', CI, 'Monitor started.'), result()]])
    played.session.send('Watch CI', 'user-1')
    await flush()
    const before = played.raw.length
    played.session.close()
    await played.session.stopTask('bid2w1')
    await flush()
    expect(played.raw).toHaveLength(before)
  })
})

describe('a scheduled job', () => {
  it('is scheduled for the whole minute after a ScheduleWakeup’s delay, clamped to 60–3600 s, and listed as a turn ends', async () => {
    const played = play([
      [
        init(),
        ...tool('a', 'ScheduleWakeup', { delaySeconds: 300, reason: 'r', prompt: 'Check it.' }, 'Scheduled.'),
        ...tool('b', 'ScheduleWakeup', { delaySeconds: 5, prompt: 'Soon.' }, 'Scheduled.'),
        ...tool('c', 'ScheduleWakeup', { delaySeconds: 99_999 }, 'Scheduled.'),
        ...tool('d', 'ScheduleWakeup', {}, 'Scheduled.'),
        result(),
      ],
    ])
    played.session.send('Later', 'user-1')
    await flush()

    const at = (hour: number, minute: number): number => new Date(2026, 8, 25, hour, minute).getTime()
    expect(details(played.raw, 'toolu_id2_1_a')).toEqual({
      scheduledFor: at(13, 13),
      clampedDelaySeconds: 300,
      wasClamped: false,
    })
    expect(details(played.raw, 'toolu_id2_1_b')).toEqual({
      scheduledFor: at(13, 9),
      clampedDelaySeconds: 60,
      wasClamped: true,
    })
    expect(details(played.raw, 'toolu_id2_1_c')).toMatchObject({ scheduledFor: at(14, 8), wasClamped: true })
    expect(details(played.raw, 'toolu_id2_1_d')).toMatchObject({ scheduledFor: at(13, 9), wasClamped: false })
    expect(played.listed).toEqual([
      [
        { id: 'id2w1', schedule: '13 13 * * *', recurring: false, prompt: 'Check it.' },
        { id: 'id2w2', schedule: '9 13 * * *', recurring: false, prompt: 'Soon.' },
        { id: 'id2w3', schedule: '8 14 * * *', recurring: false, prompt: '' },
        { id: 'id2w4', schedule: '9 13 * * *', recurring: false, prompt: '' },
      ],
    ])
  })

  it('fires with its prompt to the prompt hook; a one-off job is gone after, a recurring one stays', async () => {
    const played = play([
      [
        init(),
        ...tool('wake', 'ScheduleWakeup', { delaySeconds: 300, prompt: 'Check the rollout.' }, 'Scheduled.'),
        toolUse('cron', 'CronCreate', { cron: '*/10 * * * *', prompt: 'Check the queue.' }),
        toolResult('cron', 'Scheduled.', false, { id: 'c7a1', humanSchedule: 'Every 10 minutes' }),
        wake([init(), say('Rolled out.'), result()], { cause: WakeCause.Scheduled, job: 'wake', ms: 10 }),
        wake([init(), say('Queue is fine.'), result()], { cause: WakeCause.Scheduled, job: 'cron', ms: 20 }),
        result({ text: 'Scheduled.' }),
      ],
    ])
    played.session.send('Later', 'user-1')
    await flush(30)

    expect(details(played.raw, 'toolu_id2_1_cron')).toEqual({
      id: 'c7a1',
      humanSchedule: 'Every 10 minutes',
      recurring: true,
      durable: false,
    })
    expect(played.prompts).toEqual(['Check the rollout.', 'Check the queue.'])
    expect(of(played.raw, 'command_lifecycle')).toHaveLength(2)
    expect(said(played.raw)).toEqual(['Rolled out.', 'Queue is fine.'])
    expect(played.listed.map((jobs) => jobs.map(({ id }) => id))).toEqual([['id2w1', 'c7a1'], ['c7a1'], ['c7a1']])
    expect(of(played.raw, 'result').at(-1)).not.toHaveProperty('origin')
  })

  it('makes an id and takes the expression for a cron job without them, and a one-off one says so', async () => {
    const played = play([
      [
        init(),
        ...tool('cron', 'CronCreate', { cron: '30 14 25 9 *', prompt: 'Once.', recurring: false }, 'Scheduled.'),
        ...tool('bare', 'CronCreate', {}, 'Scheduled.'),
        result(),
      ],
    ])
    played.session.send('Later', 'user-1')
    await flush()
    expect(details(played.raw, 'toolu_id2_1_cron')).toEqual({
      id: 'id2c1',
      humanSchedule: '30 14 25 9 *',
      recurring: false,
      durable: false,
    })
    expect(played.listed).toEqual([
      [
        { id: 'id2c1', schedule: '30 14 25 9 *', recurring: false, prompt: 'Once.' },
        { id: 'id2c2', schedule: '', recurring: true, prompt: '' },
      ],
    ])
  })

  it('is deleted by CronDelete, and a ScheduleWakeup with stop cancels the wakeups; a deleted job never fires', async () => {
    const played = play([
      [
        init(),
        ...tool('wake', 'ScheduleWakeup', { delaySeconds: 300, prompt: 'Check the rollout.' }, 'Scheduled.'),
        toolUse('cron', 'CronCreate', { cron: '*/10 * * * *', prompt: 'Check the queue.' }),
        toolResult('cron', 'Scheduled.', false, { id: 'c7a1' }),
        ...tool('keep', 'CronCreate', { cron: '0 9 * * *', prompt: 'Morning.' }, 'Scheduled.'),
        ...tool('del', 'CronDelete', { id: 'c7a1' }, 'Cancelled.'),
        ...tool('del2', 'CronDelete', { id: 'nope' }, 'No such job.'),
        ...tool('del3', 'CronDelete', {}, 'No such job.'),
        ...tool('stop', 'ScheduleWakeup', { stop: true }, 'Stopped.'),
        wake([init(), say('Never.'), result()], { cause: WakeCause.Scheduled, job: 'cron', ms: 10 }),
        wake([init(), say('Never either.'), result()], { cause: WakeCause.Scheduled, job: 'wake', ms: 10 }),
        result({ text: 'Done.' }),
      ],
    ])
    played.session.send('Later', 'user-1')
    await flush(20)

    expect(details(played.raw, 'toolu_id2_1_del')).toEqual({ id: 'c7a1' })
    expect(details(played.raw, 'toolu_id2_1_del3')).toEqual({ id: '' })
    expect(details(played.raw, 'toolu_id2_1_stop')).toEqual({
      scheduledFor: 0,
      clampedDelaySeconds: 0,
      wasClamped: false,
      stopped: true,
      cancelledWakeups: 1,
    })
    expect(played.listed).toEqual([[{ id: 'id2c3', schedule: '0 9 * * *', recurring: true, prompt: 'Morning.' }]])
    expect(said(played.raw)).toEqual([])
    expect(played.prompts).toEqual([])
  })

  it('runs no turn for a fire the prompt hook turns away, as the SDK streams it', async () => {
    const played = play(
      [
        [
          init(),
          toolUse('cron', 'CronCreate', { cron: '*/10 * * * *', prompt: 'Check the queue.' }),
          toolResult('cron', 'Scheduled.', false, { id: 'c7a1' }),
          wake([init(), say('Never.'), result()], { cause: WakeCause.Scheduled, job: 'cron', ms: 10 }),
          result({ text: 'Scheduled.' }),
        ],
      ],
      { verdict: (prompt) => (prompt === 'Check the queue.' ? PromptVerdict.Block : PromptVerdict.Allow) },
    )
    played.session.send('Later', 'user-1')
    await flush()
    const idle = played.idles()
    await flush(10)

    expect(said(played.raw)).toEqual([])
    const after = played.raw.slice(played.raw.findIndex((message) => message.type === 'command_lifecycle'))
    expect(after.map((message) => (message.type === 'system' ? message.subtype : message.type))).toEqual([
      'command_lifecycle',
      'init',
      'informational',
      'result',
    ])
    expect(after[2]).toMatchObject({ content: expect.stringContaining(BLOCKED_PROMPT_REASON) as unknown })
    expect(after[3]).toMatchObject({ subtype: 'success', is_error: false })
    expect(after[3]).not.toHaveProperty('origin')
    expect(played.idles()).toBe(idle + 1)
  })

  it('comes back when the session is resumed, as the SDK restores it, and not otherwise', async () => {
    const restoredJobs = [{ id: 'c7a1', schedule: '*/10 * * * *', recurring: true, prompt: 'Check the queue.' }]
    const resumed = play([[init(), result()]], { resume: true, restoredJobs })
    resumed.session.send('Hi', 'user-1')
    await flush()
    expect(resumed.listed).toEqual([restoredJobs])

    const fresh = play([[init(), result()]], { restoredJobs })
    fresh.session.send('Hi', 'user-1')
    await flush()
    expect(fresh.listed).toEqual([[]])

    const none = play([[init(), result()]], { resume: true })
    none.session.send('Hi', 'user-1')
    await flush()
    expect(none.listed).toEqual([[]])
  })

  it('plays its wakes as the SDK does without hooks to tell', async () => {
    const played = play(
      [
        [
          init(),
          ...tool('ci', 'Monitor', CI, 'Monitor started.'),
          ...tool('wake', 'ScheduleWakeup', { delaySeconds: 60, prompt: 'Check it.' }, 'Scheduled.'),
          wake([init(), say('An event.'), result()], { cause: WakeCause.MonitorEvent, task: 'ci', ms: 10 }),
          wake([init(), say('Fired.'), result()], { cause: WakeCause.Scheduled, job: 'wake', ms: 10 }),
          result({ text: 'Started.' }),
        ],
      ],
      { hooks: false },
    )
    played.session.send('Go', 'user-1')
    await flush(20)
    expect(said(played.raw)).toEqual(['An event.', 'Fired.'])
  })
})
