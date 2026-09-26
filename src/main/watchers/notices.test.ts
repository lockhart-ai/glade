import { describe, expect, it } from 'vitest'
import { endNotice, eventNotice } from '../agent/scripted-session'
import { lastLine, parseTaskNotices } from './notices'

describe('parseTaskNotices', () => {
  it('reads a monitor event, as the probe saw it', () => {
    const prompt =
      '<task-notification>\n<task-id>b03hdfcxm</task-id>\n<summary>Monitor event: "ticks"</summary>\n' +
      '<event>tick 1</event>\n</task-notification>'
    expect(parseTaskNotices(prompt)).toEqual([
      { taskId: 'b03hdfcxm', status: null, summary: 'Monitor event: "ticks"', event: 'tick 1' },
    ])
  })

  it('reads an ending, with the last event it carries, and lines batched into one event', () => {
    expect(parseTaskNotices(endNotice('be9', 'toolu_1', 'completed', 'Monitor "burst" stream ended', 'c'))).toEqual([
      { taskId: 'be9', status: 'completed', summary: 'Monitor "burst" stream ended', event: 'c' },
    ])
    expect(parseTaskNotices(endNotice('b4f', 'toolu_2', 'failed', 'Background command "x" failed'))).toEqual([
      { taskId: 'b4f', status: 'failed', summary: 'Background command "x" failed', event: null },
    ])
    expect(parseTaskNotices(eventNotice('be9', 'burst', 'a\nb'))).toEqual([
      { taskId: 'be9', status: null, summary: 'Monitor event: "burst"', event: 'a\nb' },
    ])
  })

  it('reads every notification in one prompt, and an event that prints tags', () => {
    const prompt = `${eventNotice('b1', 'one', '<event>x</event> done')}\n${eventNotice('b2', 'two', 'y')}`
    expect(parseTaskNotices(prompt).map(({ taskId, event }) => [taskId, event])).toEqual([
      ['b1', '<event>x</event> done'],
      ['b2', 'y'],
    ])
  })

  it('reads nothing from a prompt that is not a wake, or a notification without a task id', () => {
    expect(parseTaskNotices('Check whether the docs rollout finished, and report.')).toEqual([])
    expect(parseTaskNotices('<task-notification><summary>x</summary></task-notification>')).toEqual([])
    expect(parseTaskNotices('<task-notification><task-id>  </task-id></task-notification>')).toEqual([])
    expect(parseTaskNotices('<task-notification><task-id>b1</task-id><event>x</task-notification>')).toEqual([
      { taskId: 'b1', status: null, summary: null, event: null },
    ])
  })
})

describe('lastLine', () => {
  it('is the last line with anything on it, trimmed', () => {
    expect(lastLine('a\nb\n\n  c  \n\n')).toBe('c')
    expect(lastLine('one')).toBe('one')
    expect(lastLine(' \n\n')).toBeNull()
  })
})
