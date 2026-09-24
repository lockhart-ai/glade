/**
 * The `Notifier` the test modes use in place of the OS's: it shows nothing, only records what it was asked to show, and
 * can act on a recorded notification the way the OS would: click it (or its Open task action, which does the same), or
 * reply to it. In e2e mode the app puts it on the main process's global object (`E2E_NOTIFIER_GLOBAL`), so a spec can
 * read and act on it through Playwright's `app.evaluate`.
 */
import type { NotificationHandlers, Notifier, TaskNotification } from './notifier'

export interface RecordingNotifier extends Notifier {
  /** Every notification shown so far, oldest first. */
  readonly shown: readonly TaskNotification[]
  /** Clicks the `index`th notification shown. Throws when there's no such notification. */
  click(index: number): void
  /** Sends `text` from the `index`th notification's inline reply. Throws when there's no such notification. */
  reply(index: number, text: string): void
}

export function createRecordingNotifier(): RecordingNotifier {
  const shown: TaskNotification[] = []
  const handled: NotificationHandlers[] = []
  const handlers = (index: number): NotificationHandlers => {
    const found = handled[index]
    if (found === undefined) throw new Error(`No notification ${String(index)}: ${String(shown.length)} shown`)
    return found
  }
  return {
    shown,
    show(notification, notificationHandlers) {
      shown.push(notification)
      handled.push(notificationHandlers)
    },
    click(index) {
      handlers(index).onOpen()
    },
    reply(index, text) {
      handlers(index).onReply(text)
    },
  }
}
