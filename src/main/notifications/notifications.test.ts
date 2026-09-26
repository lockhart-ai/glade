import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeErrorCode } from '../../shared/bridge'
import { TaskActivity, TaskState } from '../../shared/domain'
import { CommandFailure } from '../bridge/errors'
import { listRecentNotifications } from '../db/repositories/notifications'
import { updateSettings } from '../db/repositories/settings'
import { updateTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import {
  createReplyNotifications,
  NOTIFICATION_BODY_LENGTH,
  plainText,
  replyNotification,
  sendToTask,
  truncate,
  type ReplyRunner,
} from './notifications'
import { createRecordingNotifier } from './recording-notifier'
import { createMemoryLog } from '../logging/memory-sink'
import { LogLevel, LogScope } from '../logging/logger'

/** A runner that records what it's sent and queued. The runner's own tests cover what it does with them. */
function fakeRunner() {
  return { send: vi.fn(), queue: vi.fn() } satisfies ReplyRunner
}

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

  it('keeps to the body length', () => {
    const { body } = replyNotification({ id: 't1', title: 'T' }, 'word '.repeat(100))
    expect(body.length).toBeLessThanOrEqual(NOTIFICATION_BODY_LENGTH)
    expect(body.endsWith('…')).toBe(true)
  })

  it('makes a sound only when asked to', () => {
    expect(replyNotification({ id: 't1', title: 'T' }, 'Done.', true).silent).toBe(false)
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
    const runner = fakeRunner()
    const notify = createReplyNotifications({ db: database.db, notifier, openTask, runner })

    notify(task.id, 'It was a **race**.')

    expect(notifier.shown).toEqual([
      { taskId: task.id, title: 'Fix the login redirect', body: 'It was a race.', silent: true },
    ])
    expect(openTask).not.toHaveBeenCalled()
    notifier.click(0)
    expect(openTask).toHaveBeenCalledExactlyOnceWith(task.id)
    expect(runner.send).not.toHaveBeenCalled()
  })

  it('shows nothing while notifications are off in the settings', () => {
    const task = sampleTask(database.db, sampleWorkspace(database.db).id)
    updateSettings(database.db, { notifications: false })
    const notifier = createRecordingNotifier()
    const notify = createReplyNotifications({ db: database.db, notifier, openTask: vi.fn(), runner: fakeRunner() })

    notify(task.id, 'Done.')
    expect(notifier.shown).toEqual([])

    // Turning them back on takes effect from the next reply.
    updateSettings(database.db, { notifications: true })
    notify(task.id, 'Done again.')
    expect(notifier.shown).toHaveLength(1)
  })

  it('notes each notification sent, as it said it, for the menu bar, and says so once it has', () => {
    const task = sampleTask(database.db, sampleWorkspace(database.db).id)
    updateTask(database.db, task.id, { title: 'Fix the login redirect' })
    const onSent = vi.fn(() => {
      // Noted before it's said: the menu bar reads it straight away.
      expect(listRecentNotifications(database.db, 5)).toHaveLength(onSent.mock.calls.length)
    })
    const notify = createReplyNotifications({
      db: database.db,
      notifier: createRecordingNotifier(),
      openTask: vi.fn(),
      runner: fakeRunner(),
      onSent,
    })

    notify(task.id, 'It was a **race**.')
    updateTask(database.db, task.id, { title: 'Renamed since' })
    notify(task.id, 'Fixed it.')

    expect(onSent).toHaveBeenCalledTimes(2)
    expect(listRecentNotifications(database.db, 5).map(({ taskId, title, body }) => ({ taskId, title, body }))).toEqual(
      [
        { taskId: task.id, title: 'Renamed since', body: 'Fixed it.' },
        { taskId: task.id, title: 'Fix the login redirect', body: 'It was a race.' },
      ],
    )
  })

  it('notes nothing, and says nothing, for a notification not sent: notifications off, or no such task', () => {
    const task = sampleTask(database.db, sampleWorkspace(database.db).id)
    updateSettings(database.db, { notifications: false })
    const onSent = vi.fn()
    const notify = createReplyNotifications({
      db: database.db,
      notifier: createRecordingNotifier(),
      openTask: vi.fn(),
      runner: fakeRunner(),
      onSent,
    })

    notify(task.id, 'Done.')
    notify('gone', 'Done.')

    expect(onSent).not.toHaveBeenCalled()
    expect(listRecentNotifications(database.db, 5)).toEqual([])
  })

  it('makes a sound when the settings have sound on', () => {
    const task = sampleTask(database.db, sampleWorkspace(database.db).id)
    updateSettings(database.db, { notificationSound: true })
    const notifier = createRecordingNotifier()
    createReplyNotifications({ db: database.db, notifier, openTask: vi.fn(), runner: fakeRunner() })(task.id, 'Done.')

    expect(notifier.shown).toEqual([expect.objectContaining({ silent: false })])
  })

  it('sends its inline reply to the task, without opening it', () => {
    const task = sampleTask(database.db, sampleWorkspace(database.db).id)
    const notifier = createRecordingNotifier()
    const openTask = vi.fn()
    const runner = fakeRunner()
    createReplyNotifications({ db: database.db, notifier, openTask, runner })(task.id, 'Should I also fix the header?')

    notifier.reply(0, 'Yes, please.')

    expect(runner.send).toHaveBeenCalledExactlyOnceWith(task.id, 'Yes, please.')
    expect(openTask).not.toHaveBeenCalled()
  })

  it("logs a reply it couldn't send, such as to a task deleted since", () => {
    const task = sampleTask(database.db, sampleWorkspace(database.db).id)
    const notifier = createRecordingNotifier()
    const failure = new CommandFailure(BridgeErrorCode.NotFound, `No task ${task.id}`)
    const runner = fakeRunner()
    runner.send.mockImplementation(() => {
      throw failure
    })
    const log = createMemoryLog(LogScope.Notifications)
    createReplyNotifications({ db: database.db, notifier, openTask: vi.fn(), runner, log: log.logger })(
      task.id,
      'Done.',
    )

    notifier.reply(0, 'Thanks.')

    expect(log.withMessage("couldn't send the reply from a notification")).toEqual([
      expect.objectContaining({ level: LogLevel.Warn, fields: { taskId: task.id, error: failure } }),
    ])
  })

  it('shows nothing for a task that no longer exists', () => {
    const notifier = createRecordingNotifier()
    createReplyNotifications({ db: database.db, notifier, openTask: vi.fn(), runner: fakeRunner() })('gone', 'Done.')
    expect(notifier.shown).toEqual([])
  })

  it('logs each notification sent, opened and replied to, and one not sent, without the reply', () => {
    const task = sampleTask(database.db, sampleWorkspace(database.db).id)
    updateTask(database.db, task.id, { title: 'Fix the login redirect' })
    const notifier = createRecordingNotifier()
    const log = createMemoryLog(LogScope.Notifications)
    const notify = createReplyNotifications({
      db: database.db,
      notifier,
      openTask: vi.fn(),
      runner: fakeRunner(),
      log: log.logger,
    })

    notify(task.id, 'It was a race.')
    notifier.click(0)
    notifier.reply(0, 'Nice, thanks.')
    updateSettings(database.db, { notifications: false })
    notify(task.id, 'Done again.')

    expect(log.records.map(({ level, message, fields }) => ({ level, message, fields }))).toEqual([
      {
        level: LogLevel.Info,
        message: 'notification sent',
        fields: { taskId: task.id, title: 'Fix the login redirect', silent: true },
      },
      { level: LogLevel.Info, message: 'notification opened', fields: { taskId: task.id } },
      { level: LogLevel.Info, message: 'notification replied to', fields: { taskId: task.id, chars: 13 } },
      { level: LogLevel.Debug, message: 'notification not sent: notifications are off', fields: { taskId: task.id } },
    ])
    expect(JSON.stringify(log.records)).not.toContain('race')
  })
})

describe('sendToTask', () => {
  let database: TestDatabase
  let taskId: string

  beforeEach(() => {
    database = openTestDatabase()
    taskId = sampleTask(database.db, sampleWorkspace(database.db).id).id
  })

  afterEach(() => {
    database.close()
  })

  it('sends the message, trimmed, as the next turn when the agent is waiting on you', () => {
    const runner = fakeRunner()
    sendToTask(database.db, runner, taskId, '  Yes, please.\n')
    expect(runner.send).toHaveBeenCalledExactlyOnceWith(taskId, 'Yes, please.')
    expect(runner.queue).not.toHaveBeenCalled()
  })

  it('sends to a done task, which reopens it, as the input bar does', () => {
    updateTask(database.db, taskId, { state: TaskState.Done, activity: TaskActivity.Working })
    const runner = fakeRunner()
    sendToTask(database.db, runner, taskId, 'One more thing.')
    expect(runner.send).toHaveBeenCalledExactlyOnceWith(taskId, 'One more thing.')
  })

  it.each([TaskActivity.Working, TaskActivity.Paused])('queues the message while the agent is %s', (activity) => {
    updateTask(database.db, taskId, { activity })
    const runner = fakeRunner()
    sendToTask(database.db, runner, taskId, 'And the docs.')
    expect(runner.queue).toHaveBeenCalledExactlyOnceWith(taskId, 'And the docs.')
    expect(runner.send).not.toHaveBeenCalled()
  })

  it('queues the message after all when the agent has just started working', () => {
    const runner = fakeRunner()
    runner.send.mockImplementation(() => {
      throw new CommandFailure(BridgeErrorCode.Busy, 'The agent is working')
    })
    sendToTask(database.db, runner, taskId, 'And the docs.')
    expect(runner.queue).toHaveBeenCalledExactlyOnceWith(taskId, 'And the docs.')
  })

  it('throws any other failure', () => {
    const runner = fakeRunner()
    runner.send.mockImplementation(() => {
      throw new Error('boom')
    })
    expect(() => {
      sendToTask(database.db, runner, taskId, 'Hi')
    }).toThrow('boom')
    expect(runner.queue).not.toHaveBeenCalled()
  })

  it('sends nothing for a blank reply', () => {
    const runner = fakeRunner()
    sendToTask(database.db, runner, taskId, '  \n ')
    expect(runner.send).not.toHaveBeenCalled()
    expect(runner.queue).not.toHaveBeenCalled()
  })
})
