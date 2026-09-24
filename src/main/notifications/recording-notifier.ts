/**
 * The `Notifier` the test modes use in place of the OS's: it shows nothing, only records what it was asked to show, and
 * can click a recorded notification the way the OS would. In e2e mode the app puts it on the main process's global
 * object (`E2E_NOTIFIER_GLOBAL`), so a spec can read and click it through Playwright's `app.evaluate`.
 */
import type { Notifier, TaskNotification } from './notifier'

export interface RecordingNotifier extends Notifier {
  /** Every notification shown so far, oldest first. */
  readonly shown: readonly TaskNotification[]
  /** Clicks the `index`th notification shown. Throws when there's no such notification. */
  click(index: number): void
}

export function createRecordingNotifier(): RecordingNotifier {
  const shown: TaskNotification[] = []
  const clicks: (() => void)[] = []
  return {
    shown,
    show(notification, onClick) {
      shown.push(notification)
      clicks.push(onClick)
    },
    click(index) {
      const click = clicks[index]
      if (click === undefined) throw new Error(`No notification ${String(index)}: ${String(shown.length)} shown`)
      click()
    },
  }
}
