import { expect, it } from 'vitest'
import type { AttentionFields } from './attention'
import { TaskActivity, TaskState } from './domain'
import { taskIndicator, TaskIndicator } from './taskIndicator'

/** A task that has run, whose turn ended with a reply you've read, and nothing running. */
const READ: AttentionFields = {
  state: TaskState.Active,
  activity: TaskActivity.Waiting,
  sessionId: 'session-1',
  asking: false,
  awaitingPermission: false,
  unread: false,
  backgroundWork: false,
}

it.each<[string, Partial<AttentionFields>, TaskIndicator]>([
  ['with a read reply', {}, TaskIndicator.Idle],
  ['with an unread reply', { unread: true }, TaskIndicator.Waiting],
  ['asking a question mid-turn', { activity: TaskActivity.Working, asking: true }, TaskIndicator.Waiting],
  ['waiting on a permission card', { activity: TaskActivity.Working, awaitingPermission: true }, TaskIndicator.Waiting],
  ['working', { activity: TaskActivity.Working }, TaskIndicator.Working],
  // A paused turn is still under way (docs/design/html/17-usage-limit.html).
  ['paused', { activity: TaskActivity.Paused }, TaskIndicator.Working],
  ['with a read reply and background work', { backgroundWork: true }, TaskIndicator.Working],
  ['with an unread reply and background work', { unread: true, backgroundWork: true }, TaskIndicator.Waiting],
  ['stopped by an error', { activity: TaskActivity.Error }, TaskIndicator.Error],
  ['stopped by an error, with a question open', { activity: TaskActivity.Error, asking: true }, TaskIndicator.Error],
  ['never run', { sessionId: null }, TaskIndicator.Idle],
  ['done', { state: TaskState.Done }, TaskIndicator.Done],
  ['done and unread', { state: TaskState.Done, unread: true }, TaskIndicator.Done],
  ['done with an error', { state: TaskState.Done, activity: TaskActivity.Error }, TaskIndicator.Done],
])('shows a task %s as %s', (_, change, indicator) => {
  expect(taskIndicator({ ...READ, ...change })).toBe(indicator)
})
