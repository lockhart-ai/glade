/**
 * Who a broadcast reaches (#489, `docs/design/html/45-broadcast.html`): every active task, in every workspace, as the
 * Broadcast modal lists them before it's sent. Main decides who really gets it, as it sends (`tasks.broadcast`); the
 * store holds every workspace's active tasks and hears each change, so the list is main's unless one is on its way.
 */
import { TaskAttention } from '../../shared/attention'
import { TaskState, type Task } from '../../shared/domain'
import { compareRecency } from '../../shared/doneList'
import type { GladeData } from '../store/state'

type Recipients = Pick<GladeData, 'tasks' | 'workspaces'>

/** Whether a broadcast reaches a task: it's active, and its workspace is one the app has. */
function isRecipient(task: Task, workspaceIds: ReadonlySet<string>): boolean {
  return task.state === TaskState.Active && workspaceIds.has(task.workspaceId)
}

/** The workspaces with tasks a broadcast reaches, in the switcher's order: oldest first. */
export function recipientWorkspaceIds({ tasks, workspaces }: Recipients): string[] {
  const reached = new Set<string>()
  for (const task of Object.values(tasks)) if (task.state === TaskState.Active) reached.add(task.workspaceId)
  return workspaces.filter(({ id }) => reached.has(id)).map(({ id }) => id)
}

/** A workspace's tasks a broadcast reaches, as its task list orders them: pinned first, then most recently updated. */
export function recipientTaskIds({ tasks }: Pick<GladeData, 'tasks'>, workspaceId: string): string[] {
  return Object.values(tasks)
    .filter((task) => task.workspaceId === workspaceId && task.state === TaskState.Active)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || compareRecency(a, b))
    .map(({ id }) => id)
}

/** How many tasks a broadcast reaches. */
export function recipientCount({ tasks, workspaces }: Recipients): number {
  const workspaceIds = new Set(workspaces.map(({ id }) => id))
  let count = 0
  for (const task of Object.values(tasks)) if (isRecipient(task, workspaceIds)) count += 1
  return count
}

/** "9 active tasks in 3 workspaces": who the message goes to, as the modal's line under the field says it. */
export function reachText(tasks: number, workspaces: number): string {
  return `${String(tasks)} active ${tasks === 1 ? 'task' : 'tasks'} in ${String(workspaces)} ${workspaces === 1 ? 'workspace' : 'workspaces'}`
}

/** What the modal says in place of that line with no active task anywhere. */
export const NO_RECIPIENTS = 'No active tasks to send to.'

/** The rest of the line: a busy agent isn't interrupted. */
export const BUSY_NOTE = 'Busy agents get it when their turn ends.'

/** Where each recipient stands with you (`taskAttention`), as its row says it. */
export const ATTENTION_LABELS: Readonly<Record<TaskAttention, string>> = {
  [TaskAttention.NeedsYou]: 'needs you',
  [TaskAttention.Working]: 'working',
  [TaskAttention.Idle]: 'idle',
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
