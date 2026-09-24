/**
 * Links to tasks, which Copy link to task puts on the clipboard: `glade://task/<id>`. Opening one in Glade (registering
 * the `glade:` scheme with macOS) comes later; for now the link names the task.
 */

/** The link to a task. */
export function taskLink(taskId: string): string {
  return `glade://task/${encodeURIComponent(taskId)}`
}
