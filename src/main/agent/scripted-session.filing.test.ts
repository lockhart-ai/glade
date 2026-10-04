// The scripted session and the todo hub's hooks (P16-04, #495; `docs/sdk-notes.md` §16): it asks them as Claude Code
// does, and its agent does with what they tell it what its script's `filing` says. First the session alone, with
// hooks a test writes, for what it streams and asks; then through the real runner, with the hub on, for an agent that
// files late, one that never files, and the ask mode.
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Effort,
  MessageRole,
  PermissionDecisionKind,
  PermissionMode,
  ToolEventKind,
  type Task,
  type ToolCallEvent,
  type ToolInput,
} from '../../shared/domain'
import { FILE_CHILDREN_TOOL } from '../../shared/toolName'
import { subagentTodo } from '../../shared/todoHub'
import { listMessages } from '../db/repositories/messages'
import { listOwedFilings } from '../db/repositories/owed-filings'
import { listOpenPermissionRequests } from '../db/repositories/permission-requests'
import { getSettings, updateSettings } from '../db/repositories/settings'
import { updateTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { listToolEvents } from '../db/repositories/tool-events'
import { listWatchers } from '../db/repositories/watchers'
import { createQuestionBroker } from '../questions/questions'
import { readTodoHub, taskChildren } from '../todo-hub/todo-hub'
import {
  PromptVerdict,
  type AgentSessionOptions,
  type BatchCall,
  type ChildCallStarting,
  type SessionHooks,
} from './backend'
import { namedTodo } from './child-calls'
import { createGladeMcpServer, GLADE_SERVER } from './glade-tools'
import { createAgentRunner, type AgentRunner } from './runner'
import { MAX_SCRIPTED_HOLDS, ScriptedSession } from './scripted-session'
import {
  background,
  init,
  permission,
  result,
  say,
  shell,
  tool,
  toolResult,
  toolUse,
  type AgentScript,
  type ScriptedFiling,
  type ScriptTurn,
} from './scripts'
import { createTestModeAgentBackend, type TestModeAgentBackend } from './test-mode-backend'

const SESSION: AgentSessionOptions = {
  cwd: '/code/acme-api',
  model: 'claude-sample-1',
  effort: Effort.High,
  permissionMode: PermissionMode.AllowAll,
  resumeSessionId: null,
  systemPromptAppend: '',
  mcpServers: {},
}

describe('the scripted session, asked for the todo hub’s hooks', () => {
  /** What the hooks were told, in order, and what a test has them answer. */
  interface Hooked {
    readonly started: ChildCallStarting[]
    readonly batches: BatchCall[][]
    readonly endings: boolean[]
    readonly raw: Record<string, unknown>[]
    readonly done: Promise<void>
    readonly session: ScriptedSession
  }

  let ids: number

  beforeEach(() => {
    ids = 0
  })

  function play(
    turn: ScriptTurn,
    answers: {
      /** What the `PostToolBatch` hook tells the agent, batch by batch. */
      readonly told?: readonly (string | null)[]
      /** Why the `Stop` hook holds the turn's end, attempt by attempt; null lets it end. */
      readonly holds?: (attempt: number) => string | null
      readonly filing?: ScriptedFiling
      readonly hub?: boolean
      /** Called as the `PreToolUse` hook is asked about a call, before it answers. */
      readonly onStarting?: () => void
    } = {},
  ): Hooked {
    const started: ChildCallStarting[] = []
    const batches: BatchCall[][] = []
    const endings: boolean[] = []
    const hub: Partial<SessionHooks> = {
      onChildStarting: (call) => {
        started.push(call)
        answers.onStarting?.()
        return Promise.resolve(namedTodo(call.toolName, call.input)?.input ?? null)
      },
      onBatchFinished: ({ calls }) => {
        batches.push([...calls])
        return Promise.resolve(answers.told?.[batches.length - 1] ?? null)
      },
      onTurnEnding: ({ held }) => {
        endings.push(held)
        return Promise.resolve(answers.holds?.(endings.length - 1) ?? null)
      },
    }
    const hooks: SessionHooks = {
      onPrompt: () => PromptVerdict.Allow,
      onTurnEnded: () => undefined,
      onCompacted: () => undefined,
      ...(answers.hub === false ? {} : hub),
    }
    // Done once the turn's `result` has streamed, or the session has died.
    let finish: () => void = () => undefined
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    const script: AgentScript = {
      name: 'test',
      turns: [turn],
      ...(answers.filing === undefined ? {} : { filing: answers.filing }),
    }
    const session = new ScriptedSession({
      script,
      session: { ...SESSION, hooks },
      newId: () => `id-${String((ids += 1))}`,
    })
    const raw: Record<string, unknown>[] = []
    void (async () => {
      try {
        for await (const message of session.messages) {
          raw.push(message as Record<string, unknown>)
          if ((message as { type?: string }).type === 'result') finish()
        }
      } catch (error) {
        raw.push({ type: 'died', message: (error as Error).message })
        finish()
      }
    })()
    session.send('Go.', 'uuid-1')
    return { started, batches, endings, raw, done, session }
  }

  /** The `task_started` descriptions the session streamed, as the SDK says of each task. */
  function descriptions(raw: readonly Record<string, unknown>[]): unknown[] {
    return raw.filter(({ subtype }) => subtype === 'task_started').map(({ description }) => description)
  }

  /** The inputs of the `tool_use` blocks the session streamed, as the model wrote them. */
  function written(raw: readonly Record<string, unknown>[]): ToolInput[] {
    return raw
      .flatMap((message) => {
        const content = (message.message as { content?: { type: string; input: ToolInput }[] } | undefined)?.content
        return message.type === 'assistant' ? (content ?? []).filter(({ type }) => type === 'tool_use') : []
      })
      .map(({ input }) => input)
  }

  it('streams a call as the model wrote it, runs an Agent call with the input the hook hands back, and a watcher’s as written', async () => {
    const played = play([
      init(),
      toolUse('review', 'Agent', { description: '[todo 1] Review the date helpers', prompt: 'Review.' }),
      toolResult('review', 'Nothing else builds a date in local time.'),
      ...tool('ci', 'Monitor', { description: '[todo 3] CI checks', command: 'gh pr checks 42' }, 'Monitor started.'),
      ...tool(
        'tests',
        'Bash',
        { description: '[todo 2] Integration tests', command: 'npm test', run_in_background: true },
        'Command running in background.',
      ),
      toolUse('cron', 'CronCreate', { cron: '0 9 * * *', prompt: '[todo 3] Check the PR.' }),
      toolResult('cron', 'Scheduled.', false, { id: 'c4f1' }),
      ...tool('status', 'Bash', { description: '[todo 2] Check the tree', command: 'git status' }, 'clean'),
      background('helper', { description: '[todo 2] Fix the test', prompt: 'Fix it.' }, [], { summary: 'Fixed.' }),
      say('Done.'),
      result(),
    ])
    await played.done

    // The stream has each call as written.
    expect(written(played.raw).map((input) => input.description ?? input.prompt)).toEqual([
      '[todo 1] Review the date helpers',
      '[todo 3] CI checks',
      '[todo 2] Integration tests',
      '[todo 3] Check the PR.',
      '[todo 2] Check the tree',
      '[todo 2] Fix the test',
    ])
    // The hook was asked about the `Agent` calls and the command in the foreground, and no watcher's call.
    expect(
      played.started.map(({ toolName, toolUseId, agentId }) => [toolName, toolUseId.replace(/^.*_/, ''), agentId]),
    ).toEqual([
      ['Agent', 'review', null],
      ['Bash', 'status', null],
      ['Agent', 'helper', null],
    ])
    // What the SDK says of a subagent from then on has no marker; a watcher's task is as its call was written.
    expect(descriptions(played.raw)).toEqual([
      'Review the date helpers',
      '[todo 3] CI checks',
      '[todo 2] Integration tests',
      'Check the tree',
      'Fix the test',
    ])
    expect(
      played.batches.map((calls) => calls.map(({ toolName, input }) => [toolName, input.description ?? input.prompt])),
    ).toEqual([
      [['Agent', 'Review the date helpers']],
      [['Monitor', '[todo 3] CI checks']],
      [['Bash', '[todo 2] Integration tests']],
      [['CronCreate', '[todo 3] Check the PR.']],
      [['Bash', 'Check the tree']],
      [['Agent', 'Fix the test']],
    ])
    expect(played.endings).toEqual([false])
    expect(played.raw.at(-1)).toMatchObject({ type: 'result', result: 'Done.' })
  })

  it('asks about a subagent’s Agent call, saying whose it is, and nothing about its other calls', async () => {
    const played = play([
      init(),
      toolUse('review', 'Agent', { description: 'Review the date helpers' }),
      toolUse(
        'tests',
        'Bash',
        { command: 'npm test', description: '[todo 2] Tests', run_in_background: true },
        'review',
      ),
      toolResult('tests', 'Command running in background.'),
      toolUse('commit', 'Bash', { command: 'git commit -am "Fix"', description: '[todo 2] Commit' }, 'review'),
      toolResult('commit', '[main abc1234] Fix'),
      toolUse('nested', 'Agent', { description: '[todo 9] Check the fixtures' }, 'review'),
      toolResult('nested', 'Fine.'),
      toolResult('review', 'Reviewed.'),
      say('Done.'),
      result(),
    ])
    await played.done

    // The agent's own call, then its subagent's `Agent` call, which names the subagent that made it.
    expect(
      played.started.map(({ toolName, toolUseId, agentId }) => [toolName, toolUseId.replace(/^.*_/, ''), agentId]),
    ).toEqual([
      ['Agent', 'review', null],
      ['Agent', 'nested', expect.stringMatching(/review$/)],
    ])
    // The nested subagent starts without the marker; the subagent's commands ran as it wrote them.
    expect(descriptions(played.raw)).toEqual([
      'Review the date helpers',
      '[todo 2] Tests',
      '[todo 2] Commit',
      'Check the fixtures',
    ])
    // One message of the agent's own, told of once the subagent it waited on had finished: none of the subagent's.
    expect(played.batches.map((calls) => calls.map(({ toolName, output }) => [toolName, output]))).toEqual([
      [['Agent', 'Reviewed.']],
    ])
  })

  it('tells the batch hook of several calls made in one message together', async () => {
    const played = play([
      init(),
      toolUse('a', 'Agent', { description: 'Review src/dates.js' }),
      toolUse('b', 'Agent', { description: 'Review src/users.js' }),
      toolUse('read', 'Read', { file_path: 'README.md' }),
      toolResult('read', '# Acme API'),
      toolResult('a', 'Fine.'),
      toolResult('b', 'Fine too.'),
      say('Done.'),
      result(),
    ])
    await played.done

    expect(played.batches.map((calls) => calls.map(({ toolName }) => toolName))).toEqual([['Read', 'Agent', 'Agent']])
  })

  it('has its agent ignore what the hooks tell it when its script says nothing of filing', async () => {
    const played = play(
      [
        init(),
        ...tool('ci', 'Monitor', { description: 'CI checks', command: 'gh pr checks 42' }, 'Started.'),
        say('Done.'),
        result(),
      ],
      { told: ['- c1: watcher "CI checks"'], holds: (attempt) => (attempt < 2 ? '- c1: watcher "CI checks"' : null) },
    )
    await played.done

    expect(played.batches).toHaveLength(1)
    // Held twice, it wrote its reply again each time, and made no call.
    expect(played.endings).toEqual([false, true, true])
    expect(written(played.raw)).toHaveLength(1)
    const texts = played.raw.flatMap((message) => {
      const content = (message.message as { content?: { type: string; text: string }[] } | undefined)?.content
      return message.type === 'assistant' ? (content ?? []).filter(({ type }) => type === 'text') : []
    })
    expect(texts.map(({ text }) => text)).toEqual(['Done.', 'Done.', 'Done.'])
  })

  it('files nothing for a child its script gives no todo, and dies if it has no Glade tools to file with', async () => {
    const turn: ScriptTurn = [
      init(),
      ...tool('ci', 'Monitor', { description: 'CI checks', command: 'gh pr checks 42' }, 'Started.'),
      say('Done.'),
      result(),
    ]
    const unmatched = play(turn, {
      told: ['- c1: watcher "CI checks"'],
      filing: { todos: { 'Deploy to staging': '2' } },
    })
    await unmatched.done
    expect(written(unmatched.raw)).toHaveLength(1)
    expect(unmatched.raw.at(-1)).toMatchObject({ type: 'result' })

    // A script whose agent files needs the tool it files with: without the Glade server, that's a mistake, loudly.
    const noTools = play(turn, { told: ['- c1: watcher "CI checks"'], filing: { todos: { 'CI checks': '2' } } })
    await noTools.done
    expect(written(noTools.raw).at(-1)).toEqual({ filings: [{ child: 'c1', todo: '2' }] })
    expect(noTools.raw.at(-1)?.type).toBe('died')
  })

  it('dies, saying so, when the Stop hook never lets the turn end', async () => {
    const played = play([init(), say('Done.'), result()], { holds: () => 'Glade: not yet.' })
    await played.done

    expect(played.endings).toHaveLength(MAX_SCRIPTED_HOLDS + 1)
    expect(played.endings.slice(0, 3)).toEqual([false, true, true])
    expect(played.raw.at(-1)).toEqual({
      type: 'died',
      message: `The Stop hook held the end of a turn ${String(MAX_SCRIPTED_HOLDS + 1)} times: it must let go.`,
    })
  })

  it('ends an interrupted turn as interrupted, wherever a hook was being waited on', async () => {
    // Stop lands while the first call's hook decides: the call never runs, and nothing after it plays.
    const stopped = play(
      [
        init(),
        toolUse('review', 'Agent', { description: '[todo 3] Review the deploy' }),
        toolResult('review', 'Reviewed.'),
        permission('commit', 'Bash', { description: '[todo 3] Commit', command: 'git commit -am "Fix"' }, 'Committed.'),
        shell('status', 'git status', '[todo 2] Check the tree'),
        say('Done.'),
        result(),
      ],
      {
        onStarting: () => {
          void stopped.session.interrupt()
        },
      },
    )
    await stopped.done

    expect(stopped.raw.at(-1)).toMatchObject({ type: 'result', subtype: 'error_during_execution' })
    expect(stopped.started).toHaveLength(1)
    expect(descriptions(stopped.raw)).toEqual([])
    expect(stopped.batches).toEqual([])
    expect(stopped.endings).toEqual([])

    // And while the end of the turn is held.
    const held = play([init(), say('Done.'), result()], {
      holds: () => {
        void held.session.interrupt()
        return 'Glade: not yet.'
      },
    })
    await held.done
    expect(held.endings).toEqual([false])
    expect(held.raw.at(-1)).toMatchObject({ type: 'result', subtype: 'error_during_execution' })
  })

  it('plays as it always has in a session without the hub’s hooks', async () => {
    const played = play(
      [
        init(),
        ...tool('ci', 'Monitor', { description: '[todo 3] CI checks', command: 'gh pr checks 42' }, 'Started.'),
        background('helper', { description: '[todo 2] Fix the test', prompt: 'Fix it.' }, [], { summary: 'Fixed.' }),
        say('Done.'),
        result(),
      ],
      { hub: false, filing: { todos: { 'CI checks': '3' } } },
    )
    await played.done

    expect(played.started).toEqual([])
    expect(played.batches).toEqual([])
    expect(played.endings).toEqual([])
    // Nothing takes a marker off: the SDK says of each call what the model wrote.
    expect(descriptions(played.raw)).toEqual(['[todo 3] CI checks', '[todo 2] Fix the test'])
    expect(played.raw.at(-1)).toMatchObject({ type: 'result', result: 'Done.' })
  })
})

describe('a scripted agent, through the runner, with the todo hub on', () => {
  let database: TestDatabase
  let db: Database
  let task: Task
  let runner: AgentRunner | undefined
  let backend: TestModeAgentBackend

  beforeEach(() => {
    database = openTestDatabase()
    db = database.db
    task = sampleTask(db, sampleWorkspace(db).id)
    updateSettings(db, { todoHubEnabled: true })
  })

  afterEach(() => {
    runner?.close()
    runner = undefined
    database.close()
    vi.restoreAllMocks()
  })

  const TODO = [
    ...tool('create', 'TaskCreate', { subject: 'Watch the deploy' }, 'Task #1 created successfully: Watch the deploy'),
  ]
  const WATCH = tool(
    'deploy',
    'Monitor',
    { description: 'Deploy to staging', command: './deploy-status.sh' },
    'Started.',
  )
  /** A subagent started for no todo, which the turn waits on. */
  const REVIEW = [toolUse('review', 'Agent', { description: 'Review the deploy' }), toolResult('review', 'It is fine.')]

  function start(script: AgentScript): AgentRunner {
    backend = createTestModeAgentBackend({ script })
    const base = { db, emit: () => undefined }
    const context = { ...base, questions: createQuestionBroker(base) }
    runner = createAgentRunner({
      ...context,
      backend,
      mcpServers: (forTask) => ({ [GLADE_SERVER]: createGladeMcpServer(context, forTask.id, getSettings(db)) }),
    })
    return runner
  }

  async function send(agent: AgentRunner, text: string): Promise<void> {
    agent.send(task.id, text)
    await backend.whenIdle()
  }

  function toolCalls(): ToolCallEvent[] {
    return listToolEvents(db, task.id).filter((event): event is ToolCallEvent => event.kind === ToolEventKind.ToolCall)
  }

  function narrated(): string[] {
    return listToolEvents(db, task.id).flatMap((event) => (event.kind === ToolEventKind.Narration ? [event.text] : []))
  }

  function replies(): string[] {
    return listMessages(db, task.id)
      .filter(({ role }) => role === MessageRole.Agent)
      .map(({ body }) => body)
  }

  /** Each todo's children as `kind source`, then the ones under no todo. */
  function placed(): string[][] {
    const { todos, unfiled } = readTodoHub(db, task.id).children
    return [...todos, unfiled].map((group) =>
      group.children.map(({ kind, source }) => `${kind} ${source ?? 'unfiled'}`),
    )
  }

  /** The todos the task's subagents work on, in the order they started: plumbing, which no todo shows. */
  function working(): (string | null)[] {
    const children = taskChildren(db, task.id)
    return children.subagents.map(({ toolUseId }) => subagentTodo(children, toolUseId))
  }

  it('files at the end of its turn when it ignored Glade right after the call: held once, its reply written again', async () => {
    const agent = start({
      name: 'files-when-held',
      turns: [[init(), ...TODO, ...REVIEW, say('The deploy is reviewed.'), result()]],
      filing: { todos: { 'Review the deploy': '1' }, onlyWhenHeld: true },
    })

    await send(agent, 'Review the staging deploy.')

    expect(placed()).toEqual([[], []])
    expect(working()).toEqual(['1'])
    expect(toolCalls().map(({ name }) => name)).toEqual(['TaskCreate', 'Agent', FILE_CHILDREN_TOOL])
    // The reply it wrote before the hold is in the tool log; the user reads the one it ended on.
    expect(narrated()).toEqual(['The deploy is reviewed.'])
    expect(replies()).toEqual(['The deploy is reviewed.'])
    expect(listOwedFilings(db, task.id)).toEqual([])
  })

  it('is held twice when it never files, then its turn ends; the end of its next turn holds twice more', async () => {
    const agent = start({
      name: 'never-files',
      turns: [
        [init(), ...TODO, ...REVIEW, say('The deploy is reviewed.'), result()],
        [init(), say('Nothing new.'), result()],
      ],
    })

    await send(agent, 'Review the staging deploy.')

    // Told after the call, then held twice: it only wrote its reply again, and the turn ended all the same.
    expect(toolCalls().map(({ name }) => name)).toEqual(['TaskCreate', 'Agent'])
    expect(narrated()).toEqual(['The deploy is reviewed.', 'The deploy is reviewed.'])
    expect(replies()).toEqual(['The deploy is reviewed.'])
    // Its subagent has no todo, and one is still owed.
    expect(placed()).toEqual([[], []])
    expect(working()).toEqual([null])
    expect(listOwedFilings(db, task.id)).toHaveLength(1)

    await send(agent, 'Anything new?')

    expect(narrated().slice(2)).toEqual(['Nothing new.', 'Nothing new.'])
    expect(replies()).toEqual(['The deploy is reviewed.', 'Nothing new.'])
    expect(working()).toEqual([null])
  })

  it('is never told of a watcher, or held for one: its turn ends once, on its reply', async () => {
    const agent = start({
      name: 'only-watches',
      turns: [[init(), ...TODO, ...WATCH, say('The deploy is being watched.'), result()]],
      // It would file a watcher if it were told of one.
      filing: { todos: { 'Deploy to staging': '1' } },
    })

    await send(agent, 'Watch the staging deploy.')

    expect(toolCalls().map(({ name }) => name)).toEqual(['TaskCreate', 'Monitor'])
    expect(narrated()).toEqual([])
    expect(replies()).toEqual(['The deploy is being watched.'])
    expect(listWatchers(db, task.id)).toHaveLength(1)
    // Nor is it under no todo: a watcher is no child, and has no id.
    expect(placed()).toEqual([[], []])
    expect(listWatchers(db, task.id)).toHaveLength(1)
    expect(db.prepare('SELECT COUNT(*) FROM child_ids').pluck().get()).toBe(0)
    expect(listOwedFilings(db, task.id)).toEqual([])
  })

  it('still asks about a call that names its todo, in the ask mode, and asks about it without the marker', async () => {
    updateTask(db, task.id, { permissionMode: PermissionMode.AskBeforeEdits })
    const command = 'git commit -am "Fix the deploy script"'
    const agent = start({
      name: 'asks-about-a-named-call',
      turns: [
        [
          init(),
          ...TODO,
          permission('commit', 'Bash', { description: '[todo 1] Commit the fix', command }, 'Committed.'),
          say('The fix is committed.'),
          result(),
        ],
      ],
    })

    agent.send(task.id, 'Fix the deploy script.')
    await backend.whenIdle()

    // The hook took the marker off and decided nothing: the call waits on you, as any command does in the ask mode.
    const [request] = listOpenPermissionRequests(db, task.id)
    expect(request).toMatchObject({ toolName: 'Bash', input: { description: 'Commit the fix', command } })
    agent.answerPermission(request?.id ?? '', { kind: PermissionDecisionKind.AllowOnce })
    // The session went idle on the card: its turn plays on from the answer.
    await vi.waitFor(() => {
      expect(replies()).toHaveLength(1)
    })

    // Its row has no marker, and the turn ended unheld: the command committed nothing here, so nothing is owed.
    expect(toolCalls().at(-1)).toMatchObject({ name: 'Bash', input: { description: 'Commit the fix', command } })
    expect(narrated()).toEqual([])
    expect(replies()).toEqual(['The fix is committed.'])
  })
})
