/**
 * Native notifications (`docs/product.md`, "Attention"): an agent reply in a task you aren't viewing sends one, even
 * while Glade is focused. It shows the task's name and the start of the reply, makes no sound, and leaves Focus and Do
 * Not Disturb to the OS. Settings › Notifications can turn them off, or their sound on (`../db/repositories/settings`),
 * which takes effect from the next reply. Clicking it, or its Open task action, opens Glade on that task; its inline Reply sends what you
 * type to the task, as the input bar would, without opening the window (`docs/design/screens/04-needs-you.png`).
 *
 * Which replies notify is the unread rule's call (`../tasks/attention`): exactly the ones that arrive in a task you
 * aren't viewing. This module shapes the notification and hands it to a `Notifier`: Electron's in the app
 * (`./electron-notifier`), and a recording fake in tests and the test modes (`./recording-notifier`), which must never
 * show anything.
 */
import type { Database } from 'better-sqlite3'
import { BridgeErrorCode } from '../../shared/bridge'
import { TaskActivity, TaskState, UNTITLED_TASK_TITLE, type Task } from '../../shared/domain'
import type { AgentRunner } from '../agent/runner'
import { CommandFailure } from '../bridge/errors'
import { recordNotification } from '../db/repositories/notifications'
import { getSettings } from '../db/repositories/settings'
import { getTask } from '../db/repositories/tasks'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import type { Notifier, TaskNotification } from './notifier'

/** The most characters of the reply a notification's body shows, the ellipsis included. */
export const NOTIFICATION_BODY_LENGTH = 100

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

/**
 * The notification for an agent reply in a task: its title, and the start of the reply as plain text. It makes a sound
 * only when `sound` is on.
 */
export function replyNotification(task: Pick<Task, 'id' | 'title'>, reply: string, sound = false): TaskNotification {
  return {
    taskId: task.id,
    title: task.title === '' ? UNTITLED_TASK_TITLE : task.title,
    body: truncate(plainText(reply), NOTIFICATION_BODY_LENGTH),
    silent: !sound,
  }
}

/** Where a notification's inline reply goes: the runner, as the input bar's messages do. */
export type ReplyRunner = Pick<AgentRunner, 'send' | 'queue'>

/**
 * Sends `text` to a task the way the input bar does: queued while its agent works or its turn is paused, else sent as the next turn (which
 * reopens a done task), and queued after all if the agent has just started working. Blank text sends nothing. Throws
 * the runner's `CommandFailure` for anything else, such as a task that no longer exists.
 */
export function sendToTask(db: Database, runner: ReplyRunner, taskId: string, text: string): void {
  const message = text.trim()
  if (message === '') return
  const task = getTask(db, taskId)
  const running = task?.activity === TaskActivity.Working || task?.activity === TaskActivity.Paused
  if (task?.state === TaskState.Active && running) {
    runner.queue(taskId, message)
    return
  }
  try {
    runner.send(taskId, message)
  } catch (error) {
    if (!(error instanceof CommandFailure) || error.code !== BridgeErrorCode.Busy) throw error
    runner.queue(taskId, message)
  }
}

export interface ReplyNotificationsOptions {
  readonly db: Database
  readonly notifier: Notifier
  /** Opens a task, when its notification is clicked or its Open task action chosen. */
  readonly openTask: (taskId: string) => void
  /** What a notification's inline reply is sent through, without opening the window. */
  readonly runner: ReplyRunner
  /**
   * Called after each notification is sent and noted in the database, for the menu bar popover's Recent section to
   * show it. Nothing by default.
   */
  readonly onSent?: () => void
  /** Where each notification sent, clicked and replied to is logged. Nothing by default. */
  readonly log?: Logger
}

/**
 * Notifies each reply it's given with `notifier`, unless notifications are off in the settings, making a sound only
 * when they have it on: its Open task action (or a click) opens the reply's task, and its
 * inline reply is sent to the task (`sendToTask`), leaving the window as it is. Each one sent is noted in the database
 * (`recordNotification`), for the menu bar popover's Recent section, and `onSent` told.
 */
export function createReplyNotifications({
  db,
  notifier,
  openTask,
  runner,
  onSent,
  log = SILENT_LOGGER,
}: ReplyNotificationsOptions): NotifyReply {
  return (taskId, reply) => {
    const task = getTask(db, taskId)
    if (task === undefined) return
    const withTask = log.with({ taskId })
    const settings = getSettings(db)
    if (!settings.notifications) {
      withTask.debug('notification not sent: notifications are off')
      return
    }
    const notification = replyNotification(task, reply, settings.notificationSound)
    withTask.info('notification sent', { title: notification.title, silent: notification.silent })
    notifier.show(notification, {
      onOpen: () => {
        withTask.info('notification opened')
        openTask(taskId)
      },
      onReply: (text) => {
        withTask.info('notification replied to', { chars: text.length })
        try {
          sendToTask(db, runner, taskId, text)
        } catch (error) {
          withTask.warn("couldn't send the reply from a notification", { error })
        }
      },
    })
    recordNotification(db, { taskId, title: notification.title, body: notification.body })
    onSent?.()
  }
}
