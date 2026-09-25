// What the runner logs (`docs/logs.md`): every session, turn and SDK message, each line in its scope with its task's id.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskActivity, type Task } from '../../shared/domain'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { getTask, updateTask } from '../db/repositories/tasks'
import { LogLevel, LogScope, type LogRecord } from '../logging/logger'
import { createMemoryLog, type MemoryLog } from '../logging/memory-sink'
import { FakeAgentBackend, settle } from './fake-backend'
import { createAgentRunner, type AgentRunner } from './runner'
import * as sdk from './test-sdk-messages'

let database: TestDatabase
let task: Task
let backend: FakeAgentBackend
let log: MemoryLog
let runner: AgentRunner

beforeEach(() => {
  database = openTestDatabase()
  task = sampleTask(database.db, sampleWorkspace(database.db).id)
  backend = new FakeAgentBackend()
  log = createMemoryLog(LogScope.Runner)
  runner = createAgentRunner({ db: database.db, emit: () => undefined, backend, log: log.logger })
})

afterEach(() => {
  runner.close()
  database.close()
})

/** Each record as `scope message`, for following a task's trail. */
function trail(records: readonly LogRecord[] = log.records): string[] {
  return records.map(({ scope, message }) => `${scope} ${message}`)
}

/** The one record saying `message`. */
function only(message: string): LogRecord {
  const found = log.withMessage(message)
  expect(found).toHaveLength(1)
  const [record] = found
  if (record === undefined) throw new Error(`nothing logged ${message}`)
  return record
}

describe('a turn', () => {
  it('logs the session starting, the turn, and every SDK message, each with its task id', async () => {
    runner.send(task.id, 'Find out why the login test is flaky.')
    backend.session.emit(
      sdk.init(),
      sdk.toolUse('toolu_01', 'Bash', { command: 'npm test' }),
      sdk.toolResult('toolu_01', '2 failed'),
      sdk.text('Two tests are flaky.'),
      sdk.result('Two tests are flaky.'),
    )
    await settle()

    expect(trail()).toEqual([
      'agent session starting',
      'runner turn started',
      'agent sdk message',
      'agent session id saved',
      'agent sdk message',
      'agent sdk message',
      'agent sdk message',
      'agent sdk message',
      'runner turn result',
      'runner turn ended',
    ])
    for (const record of log.records) expect(record.fields.taskId).toBe(task.id)
    expect(only('session starting').fields).toEqual({
      taskId: task.id,
      model: task.model,
      effort: task.effort,
      cwd: '/code/acme-api',
      resumeSessionId: null,
    })
    expect(only('turn started').fields).toEqual({ taskId: task.id, turn: 1, messages: 1, queued: 0, reopening: false })
    expect(only('session id saved').fields).toEqual({ taskId: task.id, sessionId: sdk.SESSION_ID, model: sdk.MODEL })
    expect(log.withMessage('sdk message').map(({ fields }) => fields.type)).toEqual([
      'system',
      'assistant',
      'user',
      'assistant',
      'result',
    ])
    expect(log.withMessage('sdk message')[1]?.fields).toMatchObject({
      blocks: [{ type: 'tool_use', name: 'Bash', id: 'toolu_01' }],
    })
    expect(only('turn result')).toMatchObject({
      level: LogLevel.Info,
      fields: {
        taskId: task.id,
        turn: 1,
        isError: false,
        terminalReason: 'completed',
        durationMs: 7620,
        totalCostUsd: 0.0285,
        usage: { inputTokens: 28, outputTokens: 553, cacheReadInputTokens: 58094, cacheCreationInputTokens: 9443 },
      },
    })
    expect(only('turn ended').fields).toEqual({ taskId: task.id, turn: 1, stopped: false })
  })

  it("hands the backend the task's agent log, for its process", async () => {
    runner.send(task.id, 'Hi')
    backend.session.options.log?.info('agent process starting', { executable: null })
    await settle()

    expect(only('agent process starting')).toMatchObject({
      scope: LogScope.Agent,
      fields: { taskId: task.id, executable: null },
    })
  })

  it('logs a resumed session by the id it resumes, and a change of settings', async () => {
    updateTask(database.db, task.id, { sessionId: 'session-earlier', model: 'claude-sample-2' })
    runner.send(task.id, 'Carry on.')
    backend.session.emit(sdk.init('session-earlier'), sdk.result('Done.'))
    await settle()
    updateTask(database.db, task.id, { model: 'claude-sample-3' })
    runner.send(task.id, 'Once more.')

    expect(only('session resuming').fields).toMatchObject({
      resumeSessionId: 'session-earlier',
      model: 'claude-sample-2',
    })
    expect(only('session settings changed').fields).toEqual({
      taskId: task.id,
      model: 'claude-sample-3',
      effort: task.effort,
    })
    expect(log.withMessage('session id saved')).toEqual([])
  })

  it('logs a stop: asked for, the turn stopped and ended', async () => {
    runner.send(task.id, 'Run the e2e suite.')
    backend.session.onInterrupt = () => {
      backend.session.emit(sdk.abortedResult())
      return Promise.resolve()
    }
    await runner.stop(task.id)

    expect(trail().slice(-5)).toEqual([
      'runner stop requested',
      'agent sdk message',
      'runner turn result',
      'runner turn ended',
      'runner turn stopped',
    ])
    expect(only('turn result').level).toBe(LogLevel.Warn)
    expect(only('turn ended').fields).toEqual({ taskId: task.id, turn: 1, stopped: true })
    expect(only('turn stopped').fields).toEqual({ taskId: task.id, turn: 1 })
  })

  it('logs an API error, its retries and the failed turn as warnings', async () => {
    runner.send(task.id, 'Hi')
    backend.session.emit(sdk.init(), sdk.apiRetry(1), sdk.apiErrorMessage(), sdk.apiErrorResult())
    await settle()

    expect(only('api retry')).toMatchObject({
      level: LogLevel.Warn,
      fields: { taskId: task.id, turn: 1, attempt: 1, maxRetries: 10, status: 529, code: 'overloaded' },
    })
    expect(only('api error')).toMatchObject({ level: LogLevel.Warn, fields: { code: 'overloaded' } })
    expect(only('turn failed')).toMatchObject({
      level: LogLevel.Warn,
      fields: { taskId: task.id, turn: 1, apiErrorStatus: 529 },
    })
    expect(log.withMessage('sdk message').filter(({ level }) => level === LogLevel.Warn)).toHaveLength(2)
  })

  it('logs the session failing, as an error', async () => {
    runner.send(task.id, 'Hi')
    backend.session.fail(new Error('spawn claude ENOENT'))
    await settle()

    expect(only('session failed')).toMatchObject({
      level: LogLevel.Error,
      scope: LogScope.Agent,
      fields: { taskId: task.id, message: 'The agent stopped: spawn claude ENOENT', turn: 1 },
    })
  })

  it('logs the usage limit, subagents and compaction', async () => {
    runner.send(task.id, 'Explore the tests.')
    backend.session.emit(
      sdk.init(),
      sdk.rateLimit('allowed_warning', 1_790_000_000),
      sdk.toolUse('toolu_09', 'Agent', { prompt: 'Explore' }),
      { type: 'system', subtype: 'task_started', task_id: 'b7f3', tool_use_id: 'toolu_09', session_id: sdk.SESSION_ID },
    )
    await settle()
    await runner.stopSubagent(task.id, 'toolu_09')
    backend.session.emit(
      { type: 'system', subtype: 'status', status: 'compacting', session_id: sdk.SESSION_ID },
      ...sdk.compaction(180_000, 40_000, 'auto'),
      { type: 'system', subtype: 'status', status: null, compact_result: 'failed', session_id: sdk.SESSION_ID },
    )
    await settle()

    expect(only('rate limit')).toMatchObject({
      scope: LogScope.Agent,
      fields: { taskId: task.id, status: 'allowed_warning', resetsAt: 1_790_000_000_000 },
    })
    expect(only('subagent started').fields).toEqual({ taskId: task.id, toolUseId: 'toolu_09', sdkTaskId: 'b7f3' })
    expect(only('subagent stop requested').fields).toEqual({
      taskId: task.id,
      toolUseId: 'toolu_09',
      sdkTaskId: 'b7f3',
    })
    expect(log.withMessage('compacting').length).toBeGreaterThanOrEqual(1)
    expect(only('compacted').fields).toEqual({
      taskId: task.id,
      turn: 1,
      trigger: 'auto',
      preTokens: 180_000,
      postTokens: 40_000,
    })
    expect(only('compaction failed').level).toBe(LogLevel.Warn)
  })

  it('logs a compaction asked for, and a retry', async () => {
    updateTask(database.db, task.id, { sessionId: sdk.SESSION_ID })
    runner.compact(task.id)
    backend.session.emit(...sdk.compaction(180_000, 40_000), sdk.result(''))
    await settle()
    runner.send(task.id, 'Hi')
    backend.session.emit(sdk.apiErrorMessage(), sdk.apiErrorResult())
    await settle()
    runner.retry(task.id, 'claude-sample-2')

    expect(only('compaction requested').fields).toEqual({ taskId: task.id, turn: 1 })
    expect(only('turn retried').fields).toEqual({
      taskId: task.id,
      turn: 1,
      model: 'claude-sample-2',
      from: TaskActivity.Error,
    })
  })
})

describe('sessions ending', () => {
  it('logs each session closed, with why', async () => {
    const other = sampleTask(database.db, task.workspaceId)
    runner.send(task.id, 'Hi')
    runner.send(other.id, 'Hello')
    await settle()

    runner.discard(other.id)
    runner.close()

    expect(log.withMessage('session closed').map(({ fields }) => fields)).toEqual([
      { taskId: other.id, reason: 'task deleted', turn: 1 },
      { taskId: task.id, reason: 'app closing', turn: 1 },
    ])
    expect(log.inScope(LogScope.Agent).filter(({ message }) => message === 'session closed')).toHaveLength(2)
  })

  it('logs the turns resumed on launch', async () => {
    runner.send(task.id, 'Hi')
    backend.session.emit(sdk.init())
    await settle()
    runner.close()
    const relaunched = createMemoryLog(LogScope.Runner)
    runner = createAgentRunner({ db: database.db, emit: () => undefined, backend, log: relaunched.logger })

    runner.resumeInterrupted()

    expect(trail(relaunched.records)).toEqual([
      'runner resuming interrupted turn',
      'agent session resuming',
      'runner resumed interrupted tasks',
    ])
    expect(relaunched.withMessage('resuming interrupted turn')[0]?.fields).toEqual({
      taskId: task.id,
      turn: 1,
      sessionId: sdk.SESSION_ID,
      compacting: false,
    })
    expect(relaunched.withMessage('resumed interrupted tasks')[0]?.fields).toEqual({ resumed: [task.id] })
    expect(getTask(database.db, task.id)?.activity).toBe(TaskActivity.Working)
  })
})
