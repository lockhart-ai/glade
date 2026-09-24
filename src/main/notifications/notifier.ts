/** What shows notifications: the OS in the app (`./electron-notifier`), a recording in tests (`./recording-notifier`). */

/** A notification about a task, as a `Notifier` shows it. */
export interface TaskNotification {
  readonly taskId: string
  /** The task's title, or what an untitled task is called. */
  readonly title: string
  /** The start of the reply, as plain text. */
  readonly body: string
  readonly silent: boolean
}

/** Shows notifications: the OS's in the app, a fake in tests. */
export interface Notifier {
  /** Shows `notification`, calling `onClick` if it's clicked. */
  show(notification: TaskNotification, onClick: () => void): void
}
