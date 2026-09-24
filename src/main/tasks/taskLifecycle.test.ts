import { describe, expect, it } from 'vitest'
import { TaskState } from '../../shared/domain'
import { applyTransition, TaskTransition } from './taskLifecycle'

describe('applyTransition', () => {
  it.each([
    [TaskState.Active, TaskTransition.MarkDone, TaskState.Done],
    [TaskState.Done, TaskTransition.Reopen, TaskState.Active],
  ])('moves a task that is %s through "%s" to %s', (from, transition, to) => {
    expect(applyTransition(from, transition)).toEqual({ ok: true, to })
  })

  it.each([
    [TaskState.Done, TaskTransition.MarkDone, "Can't mark done a task that is done"],
    [TaskState.Active, TaskTransition.Reopen, "Can't reopen a task that is active"],
  ])('refuses to move a task that is %s through "%s"', (from, transition, message) => {
    expect(applyTransition(from, transition)).toEqual({ ok: false, error: { transition, from, message } })
  })
})
