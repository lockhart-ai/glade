import type { NotificationConstructorOptions } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElectronNotifier, type NativeNotification } from './electron-notifier'
import type { NotificationHandlers, TaskNotification } from './notifier'

// Each event's listener takes its own details, so the fake takes any listener and passes whatever it's fired with.
type Listener = (details: never) => void

class FakeNotification implements NativeNotification {
  static supported = true
  static made: FakeNotification[] = []
  static isSupported = (): boolean => FakeNotification.supported

  readonly listeners = new Map<string, Listener>()
  readonly show = vi.fn()

  constructor(readonly options: NotificationConstructorOptions) {
    FakeNotification.made.push(this)
  }

  on(event: string, listener: Listener): this {
    this.listeners.set(event, listener)
    return this
  }

  fire(event: string, details?: unknown): void {
    this.listeners.get(event)?.(details as never)
  }
}

const NOTIFICATION: TaskNotification = {
  taskId: 't1',
  title: 'Fix the login redirect',
  body: 'It was a race.',
  silent: true,
}

function handlers() {
  return { onOpen: vi.fn(), onReply: vi.fn() } satisfies NotificationHandlers
}

beforeEach(() => {
  FakeNotification.supported = true
  FakeNotification.made = []
})

function onlyNotification(): FakeNotification {
  expect(FakeNotification.made).toHaveLength(1)
  const [notification] = FakeNotification.made
  if (notification === undefined) throw new Error('no notification')
  return notification
}

describe('createElectronNotifier', () => {
  it('shows a native notification with the title and body, silent, with an Open task action and an inline reply', () => {
    createElectronNotifier(FakeNotification).show(NOTIFICATION, handlers())

    const notification = onlyNotification()
    expect(notification.options).toEqual({
      title: 'Fix the login redirect',
      body: 'It was a race.',
      silent: true,
      actions: [{ type: 'button', text: 'Open task' }],
      hasReply: true,
      replyPlaceholder: 'Reply…',
    })
    expect(notification.show).toHaveBeenCalledOnce()
  })

  it('opens the task when the notification is clicked, and only then', () => {
    const on = handlers()
    createElectronNotifier(FakeNotification).show(NOTIFICATION, on)
    const notification = onlyNotification()

    notification.fire('close')
    notification.fire('failed')
    expect(on.onOpen).not.toHaveBeenCalled()
    notification.fire('click')
    expect(on.onOpen).toHaveBeenCalledOnce()
    expect(on.onReply).not.toHaveBeenCalled()
  })

  it('opens the task when its Open task action is chosen, as a click does', () => {
    const on = handlers()
    createElectronNotifier(FakeNotification).show(NOTIFICATION, on)

    onlyNotification().fire('action', { actionIndex: 0 })

    expect(on.onOpen).toHaveBeenCalledOnce()
    expect(on.onReply).not.toHaveBeenCalled()
  })

  it('answers the task with the inline reply, without opening it', () => {
    const on = handlers()
    createElectronNotifier(FakeNotification).show(NOTIFICATION, on)

    onlyNotification().fire('reply', { reply: 'Yes, and add a test.' })

    expect(on.onReply).toHaveBeenCalledExactlyOnceWith('Yes, and add a test.')
    expect(on.onOpen).not.toHaveBeenCalled()
  })

  it('shows nothing where the OS does not support notifications', () => {
    FakeNotification.supported = false
    createElectronNotifier(FakeNotification).show(NOTIFICATION, handlers())
    expect(FakeNotification.made).toEqual([])
  })
})
