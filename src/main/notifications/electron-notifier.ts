/**
 * The app's `Notifier`: native notifications through Electron's `Notification`. The icon is the app's own, from its
 * bundle. Never used in a test mode, which must never show anything (see `./recording-notifier`).
 *
 * Each notification has an Open task action, which does what clicking it does, and an inline Reply
 * (`docs/design/screens/04-needs-you.png`). macOS only shows a notification's actions for a signed app: release builds
 * are ad-hoc signed (`electron-builder.yml`), but `npm run dev` and other unsigned builds may show neither. The
 * notification still shows, and clicking it still opens the task: an action you can't see is just never chosen.
 * With an inline reply, macOS shows only the first action, so Open task is the only one.
 */
import type { NotificationConstructorOptions } from 'electron'
import type { Notifier } from './notifier'

/** The notification's one action button, which opens its task. */
export const OPEN_TASK_ACTION = 'Open task'

/** What the notification's inline reply field says when it's empty: what the input bar says in a started task. */
export const REPLY_PLACEHOLDER = 'Reply…'

/** The part of an Electron `Notification` the notifier uses, so tests can stand in a fake. */
export interface NativeNotification {
  on(event: 'click' | 'close' | 'failed', listener: () => void): unknown
  on(event: 'action', listener: (details: { readonly actionIndex: number }) => void): unknown
  on(event: 'reply', listener: (details: { readonly reply: string }) => void): unknown
  show(): void
}

/** The part of Electron's `Notification` class the notifier uses. */
export interface NativeNotificationClass {
  new (options: NotificationConstructorOptions): NativeNotification
  isSupported(): boolean
}

/**
 * A notifier that shows each notification with `Notification`, or does nothing where the OS doesn't support them. It
 * holds on to each notification until it's clicked, acted on, replied to, closed or fails, since Electron stops
 * calling a notification's listeners once it's garbage collected.
 */
export function createElectronNotifier(Notification: NativeNotificationClass): Notifier {
  const showing = new Set<NativeNotification>()
  return {
    show({ title, body, silent }, { onOpen, onReply }) {
      if (!Notification.isSupported()) return
      const notification = new Notification({
        title,
        body,
        silent,
        actions: [{ type: 'button', text: OPEN_TASK_ACTION }],
        hasReply: true,
        replyPlaceholder: REPLY_PLACEHOLDER,
      })
      const forget = (): void => {
        showing.delete(notification)
      }
      const open = (): void => {
        forget()
        onOpen()
      }
      notification.on('click', open)
      // Open task is the only action.
      notification.on('action', open)
      notification.on('reply', ({ reply }) => {
        forget()
        onReply(reply)
      })
      notification.on('close', forget)
      notification.on('failed', forget)
      showing.add(notification)
      notification.show()
    },
  }
}
