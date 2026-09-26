/**
 * Glade in the macOS menu bar (`docs/design/html/29-menu-bar.html`): an icon showing what's in flight, and a popover
 * under it listing it. Main works out what's in flight from the database (`src/main/menu-bar`) as a `MenuBarSnapshot`,
 * draws the icon from it (`menuBarIcon`), and hands it to the popover's page (`src/renderer/menu-bar`), which shows it.
 *
 * - **Needs you:** every workspace's tasks that need you (the task list's rule, `needsYou`), with why.
 * - **Working:** every workspace's tasks whose agent is working (or paused, which resumes on its own), with their
 *   status line, todo progress and when their turn started.
 * - **Recent:** the latest notifications Glade sent, kept in the database so they're there after a relaunch.
 */
import { needsYou, type AttentionFields } from './attention'
import {
  TaskActivity,
  TaskState,
  UNTITLED_TASK_TITLE,
  type EpochMs,
  type Task,
  type TaskPause,
  type TodoSummary,
  type Workspace,
} from './domain'

/** The popover's width, in CSS pixels (`docs/design/html/29-menu-bar.html`). Its height follows what it lists. */
export const MENU_BAR_POPOVER_WIDTH = 360

/** The most a popover can ask to be sized to (`menuBar.fit`): more than any screen, which main keeps it within. */
export const MAX_MENU_BAR_HEIGHT = 10_000

/** How many of the latest notifications the popover's Recent section lists. */
export const RECENT_NOTIFICATIONS_SHOWN = 5

/** Why a task needs you, as its Needs you row says. */
export enum NeedsYouReason {
  /** Its agent asked you questions (`ask`) and waits on your answers. */
  Asking = 'asking',
  /** Its agent waits on your OK for a tool call. */
  Permission = 'permission',
  /** An error stopped its agent. */
  Error = 'error',
  /** Its agent replied and its turn ended: it waits on your next message. */
  Reply = 'reply',
}

/** What each reason says on its row. */
export const NEEDS_YOU_REASON_LABELS: Readonly<Record<NeedsYouReason, string>> = {
  [NeedsYouReason.Asking]: 'Asking a question',
  [NeedsYouReason.Permission]: 'Waiting for permission',
  [NeedsYouReason.Error]: 'Stopped on an error',
  [NeedsYouReason.Reply]: 'Reply waiting',
}

/** What `needsYouReason` reads of a task. */
export type NeedsYouFields = AttentionFields

/**
 * Why a task needs you, or null when it doesn't (`needsYou`). Questions come first, then a permission card: both hold
 * the turn open whatever its activity says. Otherwise the turn has ended, on an error or with a reply.
 */
export function needsYouReason(task: NeedsYouFields): NeedsYouReason | null {
  if (!needsYou(task)) return null
  if (task.asking) return NeedsYouReason.Asking
  if (task.awaitingPermission) return NeedsYouReason.Permission
  return task.activity === TaskActivity.Error ? NeedsYouReason.Error : NeedsYouReason.Reply
}

/** Whether a task shows under Working: it's active and its agent's turn is under way, working or paused. */
export function isInFlight(task: Pick<Task, 'state' | 'activity'>): boolean {
  if (task.state !== TaskState.Active) return false
  switch (task.activity) {
    case TaskActivity.Working:
    case TaskActivity.Paused:
      return true
    case TaskActivity.Waiting:
    case TaskActivity.Error:
      return false
  }
}

/** The task a row stands for, and where it is. */
export interface MenuBarTaskRef {
  readonly taskId: string
  /** Its title, or what an untitled task is called. */
  readonly title: string
  readonly workspaceId: string
  readonly workspaceName: string
}

/** A task that needs you, as its Needs you row shows it. */
export interface NeedsYouItem extends MenuBarTaskRef {
  readonly reason: NeedsYouReason
  /** When the task last changed: roughly since when it's waited on you. */
  readonly since: EpochMs
}

/** A task whose agent is working, as its Working row shows it. */
export interface WorkingItem extends MenuBarTaskRef {
  /** Its one-line status (`set_status`); empty until the agent sets one. */
  readonly status: string
  /** Its todo list in brief, as its row in the task list shows it; null when the agent keeps none. */
  readonly todos: TodoSummary | null
  /** Why its turn is paused and until when; null while it works. */
  readonly pause: TaskPause | null
  /** When its turn started, for its elapsed time; null when that isn't known. */
  readonly startedAt: EpochMs | null
}

/** A notification Glade sent, as the Recent section lists it. */
export interface SentNotification {
  /** Its place among the notifications sent: a later one has a higher number. */
  readonly seq: number
  readonly taskId: string
  /** What it said: the task's name, and the start of the message, as they were when it was sent. */
  readonly title: string
  readonly body: string
  readonly sentAt: EpochMs
}

/** What's in flight, across every workspace: what the menu bar icon shows, and its popover lists. */
export interface MenuBarSnapshot {
  /** The tasks that need you, the one that changed last first. */
  readonly needsYou: readonly NeedsYouItem[]
  /** The tasks whose agent is working, the one working longest first. */
  readonly working: readonly WorkingItem[]
  /** The latest notifications sent, newest first, at most `RECENT_NOTIFICATIONS_SHOWN`. */
  readonly recent: readonly SentNotification[]
}

/** A snapshot with nothing in flight. */
export const EMPTY_MENU_BAR_SNAPSHOT: MenuBarSnapshot = { needsYou: [], working: [], recent: [] }

/** What `menuBarSnapshot` works a snapshot out from. */
export interface MenuBarSources {
  /** Every workspace's tasks: any that are done, or neither working nor needing you, are left out. */
  readonly tasks: readonly Task[]
  readonly workspaces: readonly Workspace[]
  /** When a task's current turn started, or null when that isn't known. */
  readonly turnStartedAt: (taskId: string) => EpochMs | null
  /** The latest notifications sent, newest first: only the first `RECENT_NOTIFICATIONS_SHOWN` are kept. */
  readonly recent: readonly SentNotification[]
}

/**
 * What's in flight: the tasks that need you, newest change first, and those whose agent is working, working longest
 * first (a turn whose start isn't known goes last), each by its title and its workspace's name; ties go by id, so the
 * rows don't swap places as they refresh. A task whose workspace isn't listed is left out.
 */
export function menuBarSnapshot({ tasks, workspaces, turnStartedAt, recent }: MenuBarSources): MenuBarSnapshot {
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]))
  const needs: NeedsYouItem[] = []
  const working: WorkingItem[] = []
  for (const task of tasks) {
    const workspaceName = names.get(task.workspaceId)
    if (workspaceName === undefined) continue
    const ref: MenuBarTaskRef = {
      taskId: task.id,
      title: task.title === '' ? UNTITLED_TASK_TITLE : task.title,
      workspaceId: task.workspaceId,
      workspaceName,
    }
    const reason = needsYouReason(task)
    if (reason !== null) {
      needs.push({ ...ref, reason, since: task.updatedAt })
    } else if (isInFlight(task)) {
      const startedAt = turnStartedAt(task.id)
      // Only a paused turn shows why it's paused: a pause left on a working task is stale.
      const pause = task.activity === TaskActivity.Paused ? task.pause : null
      working.push({ ...ref, status: task.status, todos: task.todos, pause, startedAt })
    }
  }
  const byId = (a: MenuBarTaskRef, b: MenuBarTaskRef): number => (a.taskId < b.taskId ? -1 : 1)
  needs.sort((a, b) => b.since - a.since || byId(a, b))
  working.sort((a, b) => startOrder(a.startedAt) - startOrder(b.startedAt) || byId(a, b))
  return { needsYou: needs, working, recent: recent.slice(0, RECENT_NOTIFICATIONS_SHOWN) }
}

/** Where a turn's start sorts: an unknown one after every known one. */
function startOrder(startedAt: EpochMs | null): number {
  return startedAt ?? Number.MAX_SAFE_INTEGER
}

/** What the menu bar icon shows. */
export interface MenuBarIcon {
  /** Beside the glyph: how many tasks need you, or nothing when none do. */
  readonly title: string
  /** Whether the glyph pulses: while any agent works (a paused one waits), unless Reduce motion is on. */
  readonly pulse: boolean
}

/**
 * What the icon shows for a snapshot: the Needs you count, and a pulse while any agent works and motion's allowed. A
 * paused turn is listed under Working, but its agent isn't doing anything until it resumes, so it doesn't pulse.
 */
export function menuBarIcon(snapshot: MenuBarSnapshot, reduceMotion: boolean): MenuBarIcon {
  const count = snapshot.needsYou.length
  const working = snapshot.working.some((item) => item.pause === null)
  return { title: count === 0 ? '' : String(count), pulse: working && !reduceMotion }
}
