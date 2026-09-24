import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { updateTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import {
  createReplyNotifications,
  NOTIFICATION_DEFAULTS,
  plainText,
  replyNotification,
  truncate,
} from './notifications'
import { createRecordingNotifier } from './recording-notifier'

describe('plainText', () => {
  it.each([
    ['plain text', 'The tests pass.', 'The tests pass.'],
    [
      'emphasis and strikethrough',
      'This is **bold**, __strong__, *italic*, _slanted_ and ~~gone~~.',
      'This is bold, strong, italic, slanted and gone.',
    ],
    ['inline code', 'Call `formatDate` or ``a `tick` b``.', 'Call formatDate or a `tick` b.'],
    [
      'links and images',
      'See [the docs](https://example.com) and ![a chart](chart.png) or [ref][1].',
      'See the docs and a chart or ref.',
    ],
    ['headings', '## Summary\nAll done.', 'Summary All done.'],
    ['quotes', '> Quoted\n> > twice', 'Quoted twice'],
    [
      'lists and task boxes',
      '- one\n* two\n+ three\n1. four\n2) five\n- [x] six\n- [ ] seven',
      'one two three four five six seven',
    ],
    ['fenced code, keeping the code', 'Run:\n```sh\nnpm test\n```\n~~~\nok\n~~~', 'Run: npm test ok'],
    ['thematic breaks', 'Above\n\n---\n\n* * *\nBelow', 'Above Below'],
    ['HTML tags', 'A <kbd>Tab</kbd> key<br/>', 'A Tab key'],
    ['whitespace', '  Many\n\n  lines\tand   spaces  ', 'Many lines and spaces'],
  ])('strips %s', (_, markdown, text) => {
    expect(plainText(markdown)).toBe(text)
  })

  it('keeps underscores and asterisks that are not markup', () => {
    expect(plainText('Rename snake_case_name to 2 * 3 = 6.')).toBe('Rename snake_case_name to 2 * 3 = 6.')
  })
})

describe('truncate', () => {
  it('leaves text that fits alone', () => {
    expect(truncate('The tests pass.', 15)).toBe('The tests pass.')
  })

  it('cuts at the last word break, with an ellipsis, within the length', () => {
    const cut = truncate('The failing test was a timezone bug in the formatter.', 30)
    expect(cut).toBe('The failing test was a…')
    expect(cut.length).toBeLessThanOrEqual(30)
  })

  it('drops trailing punctuation at the cut', () => {
    expect(truncate('Fixed it, then ran the tests again.', 12)).toBe('Fixed it…')
  })

  it('cuts mid-word when a word takes up most of the length', () => {
    expect(truncate('Supercalifragilisticexpialidocious test', 12)).toBe('Supercalifr…')
  })
})

describe('replyNotification', () => {
  it("is the task's title, and the start of the reply as plain text, without sound", () => {
    const reply =
      'The failing test was a timezone bug: `formatDate` used the local date. It now formats in UTC, and all 148 tests pass.'

    expect(replyNotification({ id: 't1', title: 'Fix the flaky date test' }, reply)).toEqual({
      taskId: 't1',
      title: 'Fix the flaky date test',
      body: 'The failing test was a timezone bug: formatDate used the local date. It now formats in UTC, and…',
      silent: true,
    })
  })

  it('calls an untitled task what the task list does', () => {
    expect(replyNotification({ id: 't1', title: '' }, 'Done.').title).toBe('New task')
  })

  it('keeps to the default length and sound', () => {
    const { body, silent } = replyNotification({ id: 't1', title: 'T' }, 'word '.repeat(100))
    expect(body.length).toBeLessThanOrEqual(NOTIFICATION_DEFAULTS.bodyLength)
    expect(body.endsWith('…')).toBe(true)
    expect(silent).toBe(NOTIFICATION_DEFAULTS.silent)
  })
})

describe('createReplyNotifications', () => {
  let database: TestDatabase

  beforeEach(() => {
    database = openTestDatabase()
  })

  afterEach(() => {
    database.close()
  })

  it("shows a reply's notification with the task as it is now, and opens the task when it's clicked", () => {
    const task = sampleTask(database.db, sampleWorkspace(database.db).id)
    updateTask(database.db, task.id, { title: 'Fix the login redirect' })
    const notifier = createRecordingNotifier()
    const openTask = vi.fn()
    const notify = createReplyNotifications({ db: database.db, notifier, openTask })

    notify(task.id, 'It was a **race**.')

    expect(notifier.shown).toEqual([
      { taskId: task.id, title: 'Fix the login redirect', body: 'It was a race.', silent: true },
    ])
    expect(openTask).not.toHaveBeenCalled()
    notifier.click(0)
    expect(openTask).toHaveBeenCalledExactlyOnceWith(task.id)
  })

  it('shows nothing for a task that no longer exists', () => {
    const notifier = createRecordingNotifier()
    createReplyNotifications({ db: database.db, notifier, openTask: vi.fn() })('gone', 'Done.')
    expect(notifier.shown).toEqual([])
  })
})
