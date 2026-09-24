/**
 * The app's `Notifier`: native notifications through Electron's `Notification`. The icon is the app's own, from its
 * bundle. Never used in a test mode, which must never show anything (see `./recording-notifier`).
 */
import type { NotificationConstructorOptions } from 'electron'
import type { Notifier } from './notifier'

/** The part of an Electron `Notification` the notifier uses, so tests can stand in a fake. */
export interface NativeNotification {
  on(event: 'click' | 'close' | 'failed', listener: () => void): unknown
  show(): void
}

/** The part of Electron's `Notification` class the notifier uses. */
export interface NativeNotificationClass {
  new (options: NotificationConstructorOptions): NativeNotification
  isSupported(): boolean
}

/**
 * A notifier that shows each notification with `Notification`, or does nothing where the OS doesn't support them. It
 * holds on to each notification until it's clicked, closed or fails, since Electron stops calling a notification's
 * listeners once it's garbage collected.
 */
export function createElectronNotifier(Notification: NativeNotificationClass): Notifier {
  const showing = new Set<NativeNotification>()
  return {
    show({ title, body, silent }, onClick) {
      if (!Notification.isSupported()) return
      const notification = new Notification({ title, body, silent })
      const forget = (): void => {
        showing.delete(notification)
      }
      notification.on('click', () => {
        forget()
        onClick()
      })
      notification.on('close', forget)
      notification.on('failed', forget)
      showing.add(notification)
      notification.show()
    },
  }
}
