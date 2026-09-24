import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Effort, MessageRole, TaskState, type Task } from '../../../shared/domain'
import { SearchField, type SearchResult } from '../../../shared/search'
import { appendMessage } from './messages'
import { parseSnippet, searchTasks } from './search'
import { createTask, updateTask } from './tasks'
import { openTestDatabase, sampleWorkspace, type TestDatabase } from './test-database'

let database: TestDatabase
let workspaceId: string

beforeEach(() => {
  database = openTestDatabase()
  workspaceId = sampleWorkspace(database.db).id
})

afterEach(() => {
  // Whatever a test did, the index still agrees with its content.
  database.db.exec("INSERT INTO search_fts (search_fts) VALUES ('integrity-check')")
  database.close()
})

interface Fields {
  readonly title?: string
  readonly objective?: string
  readonly status?: string
}

function task(fields: Fields, now = 2_000, inWorkspace = workspaceId): Task {
  return createTask(
    database.db,
    { workspaceId: inWorkspace, model: 'claude-sample-1', effort: Effort.Medium, ...fields },
    now,
  )
}

function say(taskId: string, body: string, role = MessageRole.Agent): string {
  return appendMessage(database.db, { taskId, role, body, turn: 1 }).id
}

function search(text: string): SearchResult[] {
  return searchTasks(database.db, workspaceId, text)
}

function ids(text: string): string[] {
  return search(text).map(({ taskId }) => taskId)
}

/** A snippet as text, with its matches in [brackets]. */
function shown(result: SearchResult | undefined): string {
  return (result?.snippet ?? []).map(({ text, match }) => (match ? `[${text}]` : text)).join('')
}

describe('keeping the index in step', () => {
  it('finds a new task by its title, objective and status, and a new message, yours or the agent’s', () => {
    const { id } = task({ title: 'Add rate limiting', objective: 'Stop one client starving the others.' })
    updateTask(database.db, id, { status: 'Throttling the public views.' })
    say(id, 'Give /search its own scope.', MessageRole.User)
    say(id, 'Tests pass for the limiter.')

    expect(search('rate')).toEqual([expect.objectContaining({ taskId: id, field: SearchField.Title })])
    expect(search('starving')).toEqual([expect.objectContaining({ field: SearchField.Objective })])
    expect(search('throttling')).toEqual([expect.objectContaining({ field: SearchField.Status })])
    expect(search('scope')).toEqual([expect.objectContaining({ field: SearchField.Message })])
    expect(search('limiter')).toEqual([expect.objectContaining({ field: SearchField.Message })])
  })

  it('follows a change to a field, forgetting the old text', () => {
    const { id } = task({ title: 'Untangle the retries', objective: 'Retry webhooks.', status: 'Reading.' })

    updateTask(database.db, id, { title: 'Add webhook backoff', objective: 'Back off politely.', status: 'Writing.' })

    expect(ids('untangle')).toEqual([])
    expect(ids('reading')).toEqual([])
    expect(ids('retry')).toEqual([])
    expect(ids('backoff')).toEqual([id])
    expect(ids('politely')).toEqual([id])
    expect(ids('writing')).toEqual([id])
  })

  it('finds a done task by its outcome', () => {
    const { id } = task({ title: 'Add rate limiting' })
    updateTask(database.db, id, { state: TaskState.Done, status: 'Per-key limits are live.' })

    expect(search('live')).toEqual([expect.objectContaining({ taskId: id, field: SearchField.Status })])
  })

  it('forgets a deleted message', () => {
    const { id } = task({ title: 'Add rate limiting' })
    const messageId = say(id, 'Honour the Retry-After header.')

    database.db.prepare('DELETE FROM messages WHERE id = ?').run(messageId)

    expect(ids('honour')).toEqual([])
  })

  it('forgets a deleted task, with its messages, by cascade', () => {
    const { id } = task({ title: 'Add rate limiting', objective: 'Limit per key.' })
    say(id, 'Honour the Retry-After header.')
    const kept = task({ title: 'Add rate limiting to the admin API' })

    database.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)

    expect(ids('rate')).toEqual([kept.id])
    expect(ids('honour')).toEqual([])
    expect(database.db.prepare('SELECT COUNT(*) FROM search_documents WHERE task_id = ?').pluck().get(id)).toBe(0)
  })
})

describe('what you type', () => {
  it('matches each word as a prefix, as you type', () => {
    const { id } = task({ title: 'Add rate limiting to public API' })

    expect(ids('lim')).toEqual([id])
    expect(ids('rate lim')).toEqual([id])
    expect(ids('Rate LIMITING')).toEqual([id])
    // Only the start of a word matches.
    expect(ids('imiting')).toEqual([])
  })

  it('needs every word, in the same field or message', () => {
    const { id } = task({ title: 'Add rate limiting', objective: 'Per key.' })
    task({ title: 'Add webhook retries' })

    expect(ids('add rate')).toEqual([id])
    expect(ids('rate webhook')).toEqual([])
    expect(ids('add key')).toEqual([])
  })

  it('matches a hyphenated word as a phrase', () => {
    const { id } = task({ title: 'Honour the Retry-After header' })
    task({ title: 'After a retry, log it' })

    expect(ids('Retry-After')).toEqual([id])
    expect(ids('retry-aft')).toEqual([id])
  })

  it('folds diacritics', () => {
    const { id } = task({ title: 'Fix the café menu' })

    expect(ids('cafe')).toEqual([id])
  })

  it.each([
    ['unbalanced quotes', '"rate limiting'],
    ['a star', 'rate*'],
    ['a caret', '^rate'],
    ['a minus', '-rate'],
    ['parentheses', '(rate'],
    ['a plus', 'rate + limiting'],
    ['a colon', 'rate:limiting'],
  ])('treats %s as text, never as query syntax', (_, text) => {
    const { id } = task({ title: 'Add rate limiting' })

    expect(ids(text)).toEqual([id])
  })

  it('treats operator words as words to find', () => {
    const { id } = task({ title: 'Rate limiting AND NEAR matches' })
    task({ title: 'Rate limiting' })

    expect(ids('rate AND near')).toEqual([id])
    expect(ids('NEAR (rate limiting)')).toEqual([id])
    expect(ids('rate OR near')).toEqual([])
    // A column filter is a word like any other: there's no column called that, and no such word either.
    expect(ids('body: rate')).toEqual([])
  })

  it.each([[''], ['   '], ['--- ** ""']])('finds nothing for %j, which has no words', (text) => {
    task({ title: '--- ** ""' })

    expect(search(text)).toEqual([])
  })
})

describe('results', () => {
  it('only come from the workspace searched', () => {
    const other = sampleWorkspace(database.db, '/code/acme-web')
    task({ title: 'Add rate limiting' }, 2_000, other.id)
    const { id } = task({ title: 'Add rate limiting' })

    expect(ids('rate')).toEqual([id])
  })

  it('come once per task, with the snippet from the best match outside the title', () => {
    const { id } = task({ title: 'Add rate limiting', objective: 'Return 429 with a Retry-After header.' })
    say(id, 'The client ignores Retry-After in the test helper.')

    const results = search('retry-after')

    expect(results).toHaveLength(1)
    expect(results[0]?.field).toBe(SearchField.Objective)
    const [titleOnly] = search('add')
    expect(titleOnly?.field).toBe(SearchField.Title)
    expect(shown(titleOnly)).toBe('[Add] rate limiting')
  })

  it('rank a title match above the same words in a chat, and newer tasks first when they tie', () => {
    const chat = task({ title: 'Tidy the logs' }, 3_000)
    say(chat.id, 'Webhook retries need a backoff.')
    const older = task({ title: 'Webhook retries' }, 1_000)
    const newer = task({ title: 'Webhook retries' }, 2_000)

    expect(ids('webhook retries')).toEqual([newer.id, older.id, chat.id])
  })

  it('carry a snippet around the match, cut with ellipses, the match marked and hyphenated words kept whole', () => {
    const { id } = task({ title: 'Add rate limiting' })
    say(
      id,
      'We looked at every endpoint in the service before deciding. Over the limit, return 429 with a Retry-After header so clients know when to try again and do not hammer us.',
    )

    const text = shown(search('retry-after')[0])

    expect(text).toMatch(/^….*\[Retry-After\].*…$/u)
    expect(text.split(' ').length).toBeLessThanOrEqual(14)
  })

  it('carry the markers only as parts, whatever the text holds', () => {
    const { id } = task({ title: 'Escape the <mark>' })
    say(id, 'A <b>bold</b> & <script>alert("x")</script> claim.')

    expect(search('bold')[0]?.snippet).toEqual([
      { text: 'A <b>', match: false },
      { text: 'bold', match: true },
      { text: '</b> & <script>alert("x")</script> claim.', match: false },
    ])
  })
})

describe('parseSnippet', () => {
  it('splits a snippet at its markers, joining matches with only punctuation between', () => {
    expect(parseSnippet('…a \u0002Retry\u0003-\u0002After\u0003 header…')).toEqual([
      { text: '…a ', match: false },
      { text: 'Retry-After', match: true },
      { text: ' header…', match: false },
    ])
    expect(parseSnippet('no match')).toEqual([{ text: 'no match', match: false }])
    expect(parseSnippet('\u0002all\u0003')).toEqual([{ text: 'all', match: true }])
  })
})
