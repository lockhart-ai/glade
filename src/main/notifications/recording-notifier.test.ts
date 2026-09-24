import { describe, expect, it, vi } from 'vitest'
import type { TaskNotification } from './notifier'
import { createRecordingNotifier } from './recording-notifier'

const first: TaskNotification = { taskId: 't1', title: 'One', body: 'First.', silent: true }
const second: TaskNotification = { taskId: 't2', title: 'Two', body: 'Second.', silent: true }

function handlers() {
  return { onOpen: vi.fn(), onReply: vi.fn() }
}

describe('createRecordingNotifier', () => {
  it('records what it is asked to show, in order, and clicks each one by its place', () => {
    const notifier = createRecordingNotifier()
    const onFirst = handlers()
    const onSecond = handlers()

    notifier.show(first, onFirst)
    notifier.show(second, onSecond)
    notifier.click(1)

    expect(notifier.shown).toEqual([first, second])
    expect(onFirst.onOpen).not.toHaveBeenCalled()
    expect(onSecond.onOpen).toHaveBeenCalledOnce()
    expect(onSecond.onReply).not.toHaveBeenCalled()
  })

  it('replies to each one by its place', () => {
    const notifier = createRecordingNotifier()
    const onFirst = handlers()
    const onSecond = handlers()
    notifier.show(first, onFirst)
    notifier.show(second, onSecond)

    notifier.reply(0, 'Yes, do that too.')

    expect(onFirst.onReply).toHaveBeenCalledExactlyOnceWith('Yes, do that too.')
    expect(onFirst.onOpen).not.toHaveBeenCalled()
    expect(onSecond.onReply).not.toHaveBeenCalled()
  })

  it('says so when there is no such notification to click or reply to', () => {
    const notifier = createRecordingNotifier()
    notifier.show(first, handlers())
    expect(() => {
      notifier.click(1)
    }).toThrow('No notification 1: 1 shown')
    expect(() => {
      notifier.reply(2, 'Hi')
    }).toThrow('No notification 2: 1 shown')
  })
})
