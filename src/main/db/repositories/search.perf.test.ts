// Search has to keep up with typing on a big workspace: hundreds of tasks, each with a chat log.
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Effort, MessageRole } from '../../../shared/domain'
import { appendMessage } from './messages'
import { searchTasks } from './search'
import { createTask } from './tasks'
import { openTestDatabase, sampleWorkspace, type TestDatabase } from './test-database'

const TASKS = 500
const MESSAGES_PER_TASK = 20
/** What one keystroke's search may take, well under a frame of typing. */
const BUDGET_MS = 50

const WORDS = [
  'rate',
  'limiting',
  'webhook',
  'retries',
  'header',
  'client',
  'server',
  'throttle',
  'endpoint',
  'search',
  'login',
  'flaky',
  'test',
  'helper',
  'migration',
  'schema',
  'backoff',
  'timeout',
  'session',
  'cache',
  'deploy',
  'review',
  'refactor',
  'parser',
  'config',
  'logging',
  'metrics',
  'upload',
  'invoice',
  'billing',
  'export',
  'import',
  'queue',
  'worker',
  'cron',
  'email',
  'template',
  'render',
  'router',
  'token',
]

/** A made-up sentence of `count` words, the same for the same seed. */
function sentence(seed: number, count: number): string {
  const words: string[] = []
  for (let index = 0; index < count; index += 1) {
    words.push(WORDS[(seed * 7 + index * 13 + index * index) % WORDS.length] ?? 'task')
  }
  return `${words.join(' ')}.`
}

let database: TestDatabase
let workspaceId: string

beforeAll(() => {
  database = openTestDatabase()
  const { db } = database
  workspaceId = sampleWorkspace(db).id
  db.transaction(() => {
    for (let taskIndex = 0; taskIndex < TASKS; taskIndex += 1) {
      const { id } = createTask(db, {
        workspaceId,
        model: 'claude-sample-1',
        effort: Effort.Medium,
        title: `${sentence(taskIndex, 4)} ${String(taskIndex)}`,
        objective: sentence(taskIndex + 1, 20),
        status: sentence(taskIndex + 2, 12),
      })
      for (let messageIndex = 0; messageIndex < MESSAGES_PER_TASK; messageIndex += 1) {
        appendMessage(db, {
          taskId: id,
          role: messageIndex % 2 === 0 ? MessageRole.User : MessageRole.Agent,
          body: sentence(taskIndex * MESSAGES_PER_TASK + messageIndex, 40),
          turn: 1 + Math.floor(messageIndex / 2),
        })
      }
    }
  })()
})

afterAll(() => {
  database.close()
})

const RUNS = 7

/** The CPU time this process has used, in milliseconds. */
function cpuMs(): number {
  const { user, system } = process.cpuUsage()
  return (user + system) / 1000
}

/**
 * How long the search takes: the median of a few runs, after a warm-up run, in milliseconds of CPU time. The search
 * runs synchronously on this process's thread, so its CPU time is how long it takes; unlike the wall clock, it doesn't
 * count the time the other test files running alongside (or anything else on the machine) take the CPU away.
 */
function timed(text: string): { ms: number; results: number } {
  let results = searchTasks(database.db, workspaceId, text).length
  const times: number[] = []
  for (let run = 0; run < RUNS; run += 1) {
    const start = cpuMs()
    results = searchTasks(database.db, workspaceId, text).length
    times.push(cpuMs() - start)
  }
  times.sort((a, b) => a - b)
  return { ms: times[Math.floor(RUNS / 2)] ?? Infinity, results }
}

// Each keystroke of typing a search. The sample chat reuses a small vocabulary, so the short prefixes match nearly
// every field and message: the worst case.
it.each(['r', 're', 'ret', 'retr', 'retries', 'retries b', 'retries backoff', 'webhook retries backoff', 'zzz'])(
  `answers %j on ${String(TASKS)} tasks × ${String(MESSAGES_PER_TASK)} messages within ${String(BUDGET_MS)}ms`,
  (text) => {
    const { ms, results } = timed(text)

    expect(results).toBeLessThanOrEqual(TASKS)
    expect(ms).toBeLessThan(BUDGET_MS)
  },
)

it('finds every task a common word is in', () => {
  expect(searchTasks(database.db, workspaceId, 'retries')).toHaveLength(TASKS)
})
