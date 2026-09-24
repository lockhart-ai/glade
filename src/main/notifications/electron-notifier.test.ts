import type { NotificationConstructorOptions } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElectronNotifier, type NativeNotification } from './electron-notifier'
import type { TaskNotification } from './notifier'

type Listener = () => void

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

  fire(event: string): void {
    this.listeners.get(event)?.()
  }
}

const NOTIFICATION: TaskNotification = {
  taskId: 't1',
  title: 'Fix the login redirect',
  body: 'It was a race.',
  silent: true,
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
  it('shows a native notification with the title and body, silent, with no icon of its own', () => {
    createElectronNotifier(FakeNotification).show(NOTIFICATION, vi.fn())

    const notification = onlyNotification()
    expect(notification.options).toEqual({ title: 'Fix the login redirect', body: 'It was a race.', silent: true })
    expect(notification.show).toHaveBeenCalledOnce()
  })

  it('calls back when the notification is clicked, and only then', () => {
    const onClick = vi.fn()
    createElectronNotifier(FakeNotification).show(NOTIFICATION, onClick)
    const notification = onlyNotification()

    notification.fire('close')
    notification.fire('failed')
    expect(onClick).not.toHaveBeenCalled()
    notification.fire('click')
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('shows nothing where the OS does not support notifications', () => {
    FakeNotification.supported = false
    createElectronNotifier(FakeNotification).show(NOTIFICATION, vi.fn())
    expect(FakeNotification.made).toEqual([])
  })
})
