/**
 * Who a broadcast reaches (#489, `docs/design/html/45-broadcast.html`): every active task that has an agent
 * (`receivesBroadcast`, the rule main sends by), in every workspace, as the Broadcast modal lists them as tick boxes
 * before it's sent (#675). Everything is ticked when the modal opens; the modal holds the ones it has had unticked to
 * it, and a broadcast goes to the ticked ones only. Main decides who really gets it, as it sends (`tasks.broadcast`);
 * the store holds every workspace's active tasks and hears each change, so the list is main's unless one is on its way.
 */
import { TaskAttention } from '../../shared/attention'
import { receivesBroadcast } from '../../shared/broadcast'
import type { Task } from '../../shared/domain'
import { compareRecency } from '../../shared/doneList'
import type { GladeData } from '../store/state'

type Recipients = Pick<GladeData, 'tasks' | 'workspaces'>

/** Whether the modal lists a task: a broadcast reaches it, and its workspace is one the app has. */
function isRecipient(task: Task, workspaceIds: ReadonlySet<string>): boolean {
  return receivesBroadcast(task) && workspaceIds.has(task.workspaceId)
}

/** The workspaces with tasks a broadcast reaches, in the switcher's order: oldest first. */
export function recipientWorkspaceIds({ tasks, workspaces }: Recipients): string[] {
  const reached = new Set<string>()
  for (const task of Object.values(tasks)) if (receivesBroadcast(task)) reached.add(task.workspaceId)
  return workspaces.filter(({ id }) => reached.has(id)).map(({ id }) => id)
}

/** A workspace's tasks a broadcast reaches, as its task list orders them: pinned first, then most recently updated. */
export function recipientTaskIds({ tasks }: Pick<GladeData, 'tasks'>, workspaceId: string): string[] {
  return Object.values(tasks)
    .filter((task) => task.workspaceId === workspaceId && receivesBroadcast(task))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || compareRecency(a, b))
    .map(({ id }) => id)
}

/** The tasks a broadcast reaches, as the modal lists them: each recipient workspace's, in its order. */
export function recipientIds(recipients: Recipients): string[] {
  return recipientWorkspaceIds(recipients).flatMap((workspaceId) => recipientTaskIds(recipients, workspaceId))
}

/** How many tasks a broadcast reaches. */
export function recipientCount({ tasks, workspaces }: Recipients): number {
  const workspaceIds = new Set(workspaces.map(({ id }) => id))
  let count = 0
  for (const task of Object.values(tasks)) if (isRecipient(task, workspaceIds)) count += 1
  return count
}

/**
 * How much of a workspace's tasks are ticked: all of them, only some (its box shows a dash), or none. A task row is
 * all or none, and never some.
 */
export enum WorkspaceTick {
  All = 'all',
  Some = 'some',
  None = 'none',
}

/** How much of a workspace's tasks are ticked, of the ones the modal lists for it. */
export function workspaceTick(unticked: ReadonlySet<string>, taskIds: readonly string[]): WorkspaceTick {
  let untickedCount = 0
  for (const taskId of taskIds) if (unticked.has(taskId)) untickedCount += 1
  if (untickedCount === 0) return WorkspaceTick.All
  return untickedCount === taskIds.length ? WorkspaceTick.None : WorkspaceTick.Some
}

/**
 * Ticks the given tasks (or unticks them, leaving them out of the send), as a row's box was asked: the tasks not
 * already in `unticked` are ticked. Answers the new set to hold in its place.
 */
export function setTicked(unticked: ReadonlySet<string>, taskIds: readonly string[], on: boolean): Set<string> {
  const next = new Set(unticked)
  if (on) {
    for (const taskId of taskIds) next.delete(taskId)
  } else {
    for (const taskId of taskIds) next.add(taskId)
  }
  return next
}

/** What's ticked, as the modal's line counts it: how many tasks, and in how many workspaces one is ticked. */
export interface TickedCounts {
  readonly tasks: number
  readonly workspaces: number
}

/** What's ticked of a broadcast's recipients, of the ones the modal hasn't had unticked to it (#675). */
export function tickedCounts(recipients: Recipients, unticked: ReadonlySet<string>): TickedCounts {
  let tasks = 0
  let workspaces = 0
  for (const workspaceId of recipientWorkspaceIds(recipients)) {
    const ticked = recipientTaskIds(recipients, workspaceId).filter((taskId) => !unticked.has(taskId)).length
    tasks += ticked
    if (ticked > 0) workspaces += 1
  }
  return { tasks, workspaces }
}

/** "6 of 9 active tasks in 2 workspaces": what's ticked, as the modal's line under the field says it. */
export function reachText(tasks: number, total: number, workspaces: number): string {
  return `${String(tasks)} of ${String(total)} active ${total === 1 ? 'task' : 'tasks'} in ${String(workspaces)} ${workspaces === 1 ? 'workspace' : 'workspaces'}`
}

/** What the modal says in place of that line with no active task anywhere. */
export const NO_RECIPIENTS = 'No active tasks to send to.'

/** What the modal says with recipients but none ticked: Send is off until one is. */
export const NOTHING_TICKED = 'Nothing ticked. Tick a task to send to it.'

/** The rest of the line: a busy agent isn't interrupted. */
export const BUSY_NOTE = 'Busy agents get it when their turn ends.'

/** Where a recipient stands with you (`taskAttention`), as its row says it. */
export function attentionLabel(attention: TaskAttention): string {
  switch (attention) {
    case TaskAttention.NeedsYou:
      return 'needs you'
    case TaskAttention.Working:
      return 'working'
    case TaskAttention.Idle:
      return 'idle'
  }
}

/** What the toast says when the broadcast as a whole couldn't be sent. */
export function broadcastFailureMessage(reason: string): string {
  return `Couldn’t send your broadcast: ${reason}`
}

/** What the toast says when some tasks couldn't take the broadcast: which, when it's one, and why. */
export function undeliveredMessage(failures: readonly { readonly title: string; readonly message: string }[]): string {
  const [only] = failures
  if (failures.length === 1 && only !== undefined) return `Couldn’t send to “${only.title}”: ${only.message}`
  return `Couldn’t send to ${String(failures.length)} tasks.`
}
