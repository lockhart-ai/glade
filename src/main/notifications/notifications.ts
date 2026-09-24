/**
 * Native notifications (`docs/product.md`, "Attention"): an agent reply in a task you aren't viewing sends one, even
 * while Glade is focused. It shows the task's name and the start of the reply, makes no sound, and leaves Focus and Do
 * Not Disturb to the OS. Clicking it opens Glade on that task.
 *
 * Which replies notify is the unread rule's call (`../tasks/attention`): exactly the ones that arrive in a task you
 * aren't viewing. This module shapes the notification and hands it to a `Notifier`: Electron's in the app
 * (`./electron-notifier`), and a recording fake in tests and the test modes (`./recording-notifier`), which must never
 * show anything.
 */
import type { Database } from 'better-sqlite3'
import { UNTITLED_TASK_TITLE, type Task } from '../../shared/domain'
import { getTask } from '../db/repositories/tasks'
import type { Notifier, TaskNotification } from './notifier'

/** How notifications look and sound. One place, until settings can change them (P7). */
export const NOTIFICATION_DEFAULTS = {
  /** Sound is off by default. */
  silent: true,
  /** The most characters of the reply a notification's body shows, the ellipsis included. */
  bodyLength: 100,
} as const

/** What to do with an agent reply that arrived in a task you aren't viewing. */
export type NotifyReply = (taskId: string, reply: string) => void

const ELLIPSIS = '…'

/**
 * Markdown as the plain text it reads as, on one line: the markup goes (emphasis, code, links' targets, headings,
 * quotes, list markers, fences, HTML tags) and runs of whitespace become one space. Not a full parser: it's for the
 * start of a notification, where a stray mark is harmless.
 */
export function plainText(markdown: string): string {
  return (
    markdown
      // Fence lines, keeping the code between them.
      .replace(/^ {0,3}(`{3,}|~{3,}).*$/gm, '')
      // Thematic breaks.
      .replace(/^ {0,3}([-*_])( *\1){2,} *$/gm, '')
      // Headings, quotes, list markers and task boxes at the start of a line.
      .replace(/^ {0,3}#{1,6}(?=\s)/gm, '')
      .replace(/^ {0,3}(> ?)+/gm, '')
      .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/gm, '')
      // Images and links keep their text; reference links too.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
      .replace(/<[^>\n]+>/g, '')
      // Inline code, then emphasis and strikethrough. Underscores only mark emphasis at word edges, not in snake_case.
      .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, '$2')
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/\*(?=\S)([^*]*?\S)\*/g, '$1')
      .replace(/(^|\W)_(?=\S)([^_]*?\S)_(?=\W|$)/g, '$1$2')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/**
 * `text` cut to at most `length` characters, ellipsis included: at the last word break that keeps at least half of
 * it, or mid-word when a single word is that long.
 */
export function truncate(text: string, length: number): string {
  if (text.length <= length) return text
  const cut = text.slice(0, length - ELLIPSIS.length)
  const lastBreak = cut.lastIndexOf(' ')
  const kept = lastBreak >= cut.length / 2 ? cut.slice(0, lastBreak) : cut
  return `${kept.replace(/[\s,;:]+$/, '')}${ELLIPSIS}`
}

/** The notification for an agent reply in a task: its title, and the start of the reply as plain text. */
export function replyNotification(task: Pick<Task, 'id' | 'title'>, reply: string): TaskNotification {
  return {
    taskId: task.id,
    title: task.title === '' ? UNTITLED_TASK_TITLE : task.title,
    body: truncate(plainText(reply), NOTIFICATION_DEFAULTS.bodyLength),
    silent: NOTIFICATION_DEFAULTS.silent,
  }
}

export interface ReplyNotificationsOptions {
  readonly db: Database
  readonly notifier: Notifier
  /** Opens a task, when its notification is clicked. */
  readonly openTask: (taskId: string) => void
}

/** Notifies each reply it's given with `notifier`, opening the reply's task when its notification is clicked. */
export function createReplyNotifications({ db, notifier, openTask }: ReplyNotificationsOptions): NotifyReply {
  return (taskId, reply) => {
    const task = getTask(db, taskId)
    if (task === undefined) return
    notifier.show(replyNotification(task, reply), () => {
      openTask(taskId)
    })
  }
}
