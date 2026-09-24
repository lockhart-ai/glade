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

/** What a notification does when you act on it. */
export interface NotificationHandlers {
  /** Opens the notification's task: you clicked the notification, or its Open task action. */
  readonly onOpen: () => void
  /** Answers the task with what you typed in the notification's inline reply. */
  readonly onReply: (text: string) => void
}

/** Shows notifications: the OS's in the app, a fake in tests. */
export interface Notifier {
  /** Shows `notification`, with an Open task action and an inline reply, calling `handlers` as you act on it. */
  show(notification: TaskNotification, handlers: NotificationHandlers): void
}
