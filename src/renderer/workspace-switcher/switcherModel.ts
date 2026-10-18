import { needsYou } from '../../shared/attention'
import { NeedsYouReason, needsYouReason } from '../../shared/menuBar'
import { TaskState, UNTITLED_TASK_TITLE, type EpochMs, type Task, type Workspace } from '../../shared/domain'
import { formatAgo } from '../task-header/headerModel'
import { rowStatus } from '../task-list/rowStatus'

/** What a workspace's row in the switcher says about its tasks. */
export enum WorkspaceStatusKind {
  /** Some of its tasks need you (purple): the one thing to act on, so it wins. */
  NeedsYou = 'needs_you',
  /** It has active tasks, none of which needs you. */
  Active = 'active',
  /** It has no active tasks. */
  Idle = 'idle',
}

export interface WorkspaceNeedsYou {
  readonly kind: WorkspaceStatusKind.NeedsYou
  /** How many of its tasks need you. */
  readonly count: number
}

export interface WorkspaceActive {
  readonly kind: WorkspaceStatusKind.Active
  /** How many of its tasks are active. */
  readonly count: number
}

export interface WorkspaceIdle {
  readonly kind: WorkspaceStatusKind.Idle
}

export type WorkspaceStatus = WorkspaceNeedsYou | WorkspaceActive | WorkspaceIdle

/**
 * A workspace's status in the switcher (`docs/design/html/14-workspace-switcher.html`): "N needs you" when any of its
 * tasks needs you, else "N active" for its active tasks, else idle.
 */
export function workspaceStatus(tasks: Iterable<Task>, workspaceId: string): WorkspaceStatus {
  let active = 0
  let needing = 0
  for (const task of tasks) {
    if (task.workspaceId !== workspaceId || task.state !== TaskState.Active) continue
    active += 1
    if (needsYou(task)) needing += 1
  }
  if (needing > 0) return { kind: WorkspaceStatusKind.NeedsYou, count: needing }
  if (active > 0) return { kind: WorkspaceStatusKind.Active, count: active }
  return { kind: WorkspaceStatusKind.Idle }
}

/** The status as the switcher words it. */
export function describeStatus(status: WorkspaceStatus): string {
  switch (status.kind) {
    case WorkspaceStatusKind.NeedsYou:
      return `${String(status.count)} needs you`
    case WorkspaceStatusKind.Active:
      return `${String(status.count)} active`
    case WorkspaceStatusKind.Idle:
      return 'idle'
  }
}

/**
 * A task that needs you, as its row in the switcher's Needs-you section shows it (#681): which workspace it's in, for
 * the row's badge, and when it last changed, for its time.
 */
export interface NeedsYouTask {
  readonly taskId: string
  readonly workspaceId: string
  readonly workspaceName: string
  /** The workspace badge's colour, from its place among the workspaces. */
  readonly tone: BadgeTone
  /** When the task last changed: the age the row's time and "Replied … ago" line show. */
  readonly updatedAt: EpochMs
}

/**
 * Every task that needs you, across every workspace (`docs/design/html/14-workspace-switcher-tasks.html`, #681), the
 * one that changed last first — the same rule for what needs you and the same order as the menu bar popover's
 * Needs-you rows (`menuBarSnapshot`): tasks that need you (`needsYou`), in a workspace the app still has, newest
 * change first, ties by id so the rows don't swap places as they refresh.
 */
export function needsYouTasks(tasks: Iterable<Task>, workspaces: readonly Workspace[]): NeedsYouTask[] {
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]))
  const needing: NeedsYouTask[] = []
  for (const task of tasks) {
    const workspaceName = names.get(task.workspaceId)
    if (workspaceName === undefined || !needsYou(task)) continue
    needing.push({
      taskId: task.id,
      workspaceId: task.workspaceId,
      workspaceName,
      tone: badgeTone(workspaces, task.workspaceId),
      updatedAt: task.updatedAt,
    })
  }
  needing.sort((a, b) => b.updatedAt - a.updatedAt || (a.taskId < b.taskId ? -1 : 1))
  return needing
}

/**
 * A needs-you task's why line, in purple on its row: "Replied 4m ago" for an unread reply (when its agent last
 * replied, the same age the row's time shows), else the task's own status line, exactly as the task list shows it —
 * "Waiting on you: pick a limit for /search" on a permission card, the error's line, or the status the agent set.
 */
export function needsYouWhy(task: Task, now: EpochMs): string {
  if (needsYouReason(task) === NeedsYouReason.Reply) return `Replied ${formatAgo(task.updatedAt, now)}`
  return rowStatus({ task, now }).text
}

/** A needs-you task's title as its row shows it: what a task is called until its agent names it, for one without. */
export function needsYouTaskTitle(title: string): string {
  return title === '' ? UNTITLED_TASK_TITLE : title
}

/**
 * How many tasks need you (`needsYou`, the same rule everywhere) across every workspace, the one you're in included:
 * the closed switcher's own count pill (#472, corrected by #480 to count every workspace, not just the others), so
 * you find out without opening it. Always the same total as the menu bar's icon (`menuBarIcon`): a task whose
 * workspace isn't one of `workspaces` (the app no longer has it) is left out of both, the same way
 * `menuBarSnapshot` skips it.
 */
export function needsYouCount(tasks: Iterable<Task>, workspaces: readonly Workspace[]): number {
  const knownWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id))
  let count = 0
  for (const task of tasks) {
    if (!knownWorkspaceIds.has(task.workspaceId)) continue
    if (needsYou(task)) count += 1
  }
  return count
}

/** The pill's own text: the count, or `9+` past 9 (it's hidden at 0; the caller checks). */
export function pillText(count: number): string {
  return count > 9 ? '9+' : String(count)
}

/**
 * The switcher's tooltip: what it does, plus how many tasks need you, if any (the exact count, not the pill's capped
 * `9+`).
 */
export function switcherTitle(count: number): string {
  if (count === 0) return 'Switch workspace'
  const plural = count !== 1
  return `Switch workspace — ${String(count)} task${plural ? 's' : ''} need${plural ? '' : 's'} you`
}

/** The colours a workspace's badge comes in, from the design, given out in turn by workspace. */
export enum BadgeTone {
  Blue = 'blue',
  Purple = 'purple',
  Teal = 'teal',
  Pink = 'pink',
}

const TONES: readonly BadgeTone[] = [BadgeTone.Blue, BadgeTone.Purple, BadgeTone.Teal, BadgeTone.Pink]

/** A workspace's badge colour: by its place among the workspaces, oldest first, so it never changes. */
export function badgeTone(workspaces: readonly Workspace[], workspaceId: string): BadgeTone {
  const index = Math.max(
    0,
    workspaces.findIndex(({ id }) => id === workspaceId),
  )
  return TONES[index % TONES.length] ?? BadgeTone.Blue
}

/** The first character of a name, upper-cased, for the badge; ? for no name. */
export function workspaceInitial(name: string): string {
  return (Array.from(name)[0] ?? '?').toUpperCase()
}

/**
 * The workspace ⌘1 – ⌘9 switch to: the nth, oldest first (the order the switcher lists them in), or undefined past the
 * last.
 */
export function workspaceAt(workspaces: readonly Workspace[], digit: number): Workspace | undefined {
  return digit >= 1 && digit <= 9 ? workspaces[digit - 1] : undefined
}
