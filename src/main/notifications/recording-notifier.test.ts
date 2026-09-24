import { describe, expect, it, vi } from 'vitest'
import type { TaskNotification } from './notifier'
import { createRecordingNotifier } from './recording-notifier'

const first: TaskNotification = { taskId: 't1', title: 'One', body: 'First.', silent: true }
const second: TaskNotification = { taskId: 't2', title: 'Two', body: 'Second.', silent: true }

describe('createRecordingNotifier', () => {
  it('records what it is asked to show, in order, and clicks each one by its place', () => {
    const notifier = createRecordingNotifier()
    const onFirst = vi.fn()
    const onSecond = vi.fn()

    notifier.show(first, onFirst)
    notifier.show(second, onSecond)
    notifier.click(1)

    expect(notifier.shown).toEqual([first, second])
    expect(onFirst).not.toHaveBeenCalled()
    expect(onSecond).toHaveBeenCalledOnce()
  })

  it('says so when there is no such notification to click', () => {
    const notifier = createRecordingNotifier()
    notifier.show(first, vi.fn())
    expect(() => {
      notifier.click(1)
    }).toThrow('No notification 1: 1 shown')
  })
})
