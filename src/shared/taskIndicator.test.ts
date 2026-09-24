import { expect, it } from 'vitest'
import { TaskActivity, TaskState } from './domain'
import { taskIndicator, TaskIndicator } from './taskIndicator'

it.each([
  [TaskState.Active, TaskActivity.Waiting, TaskIndicator.Waiting],
  [TaskState.Active, TaskActivity.Working, TaskIndicator.Working],
  [TaskState.Active, TaskActivity.Error, TaskIndicator.Error],
  // A paused turn is still under way (docs/design/html/17-usage-limit.html).
  [TaskState.Active, TaskActivity.Paused, TaskIndicator.Working],
  [TaskState.Done, TaskActivity.Waiting, TaskIndicator.Done],
  [TaskState.Done, TaskActivity.Error, TaskIndicator.Done],
])('shows a %s task whose agent is %s as %s', (state, activity, indicator) => {
  expect(taskIndicator({ state, activity })).toBe(indicator)
})
