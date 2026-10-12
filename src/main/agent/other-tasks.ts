/**
 * What a task's agent is told of the other tasks running in Glade (#578, `docs/model-surface.md`): a read-only,
 * always-on answer so an agent that is about to pick up a pull request, an issue or a branch can see whether another
 * task already has it, without turning on Settings › Control.
 *
 * Built from the same task rows, the one attention rule (`../../shared/attention`) and the same link artifacts the
 * window and the control API use (`../db/repositories/tasks`, `../db/repositories/artifacts`), but reaches none of a
 * task's chat, tool output or files: only the fields below. Bounded to `OTHER_TASKS_MAX` tasks (the calling task is
 * always among them, even past the cap) and each field to its own length, cut with an ellipsis; `OtherTasksAnswer.cut`
 * says when any of that happened.
 */
import type { Database } from 'better-sqlite3'
import { ArtifactKind, TaskState, type EpochMs, type Task } from '../../shared/domain'
import { taskAttention, TaskAttention } from '../../shared/attention'
import { listArtifacts } from '../db/repositories/artifacts'
import { getTasks, listTaskIds } from '../db/repositories/tasks'
import { listWorkspaces } from '../db/repositories/workspaces'

/** How many Active tasks `list_other_tasks` answers with at most. The calling task is always one of them. */
export const OTHER_TASKS_MAX = 50

/** How long a title, an objective (its Goal), a status (its Now) or a workspace's name is shown, cut with an ellipsis. */
export const OTHER_TASKS_TEXT_MAX = 200

/** How many of a task's link artifacts are shown at most. */
export const OTHER_TASKS_LINKS_MAX = 20

/** How long a link's title or url is shown, cut with an ellipsis. */
export const OTHER_TASKS_LINK_TEXT_MAX = 300

/** One of another task's link artifacts: a PR, an issue or a ticket it filed with `add_artifact`'s `url`. */
export interface OtherTaskLink {
  readonly title: string
  readonly url: string
}

/** One Active task, as `list_other_tasks` tells the agent of it. */
export interface OtherTask {
  readonly id: string
  /** Empty until the task is named. */
  readonly title: string
  /** Empty until the task sets one. */
  readonly objective: string
  /** Empty until the task sets one. */
  readonly status: string
  readonly attention: TaskAttention
  readonly workspace: string
  readonly updatedAt: EpochMs
  readonly links: readonly OtherTaskLink[]
  /** Whether this is the task the call came from. */
  readonly isSelf: boolean
}

/** What `list_other_tasks` answers: the Active tasks it could show, most recently updated first. */
export interface OtherTasksAnswer {
  readonly tasks: readonly OtherTask[]
  /**
   * True when a task, a task's field or a task's links were left out or shortened to stay within the caps above.
   */
  readonly cut: boolean
}

/** A mutable flag `otherTasksAnswer` sets the first time anything is cut, threaded through its helpers. */
interface CutFlag {
  cut: boolean
}

function shortened(text: string, max: number, flag: CutFlag): string {
  if (text.length <= max) return text
  flag.cut = true
  return `${text.slice(0, max - 1)}…`
}

/** A task's link artifacts (#407), in the order they were first declared, bounded to `OTHER_TASKS_LINKS_MAX`. */
function linksOf(db: Database, taskId: string, flag: CutFlag): OtherTaskLink[] {
  const all = listArtifacts(db, taskId).filter((artifact) => artifact.kind === ArtifactKind.Link)
  if (all.length > OTHER_TASKS_LINKS_MAX) flag.cut = true
  return all.slice(0, OTHER_TASKS_LINKS_MAX).map((link) => ({
    title: shortened(link.title, OTHER_TASKS_LINK_TEXT_MAX, flag),
    url: shortened(link.url, OTHER_TASKS_LINK_TEXT_MAX, flag),
  }))
}

function otherTaskOf(db: Database, task: Task, workspaceName: string, callerTaskId: string, flag: CutFlag): OtherTask {
  return {
    id: task.id,
    title: shortened(task.title, OTHER_TASKS_TEXT_MAX, flag),
    objective: shortened(task.objective, OTHER_TASKS_TEXT_MAX, flag),
    status: shortened(task.status, OTHER_TASKS_TEXT_MAX, flag),
    attention: taskAttention(task),
    workspace: shortened(workspaceName, OTHER_TASKS_TEXT_MAX, flag),
    updatedAt: task.updatedAt,
    links: linksOf(db, task.id, flag),
    isSelf: task.id === callerTaskId,
  }
}

/** Most recently updated first, ties by id, so the order never depends on how SQLite happened to return rows. */
function byRecency(a: Task, b: Task): number {
  return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
}

/**
 * The Active tasks across every workspace, most recently updated first, for `list_other_tasks` (#578): each with its
 * title, objective (Goal), status (Now), attention (`taskAttention`), workspace and link artifacts. Done tasks are
 * never listed. Bounded to `OTHER_TASKS_MAX` tasks, but the calling task is always included, even if it would
 * otherwise fall past the cap: the agent must always be able to see where its own task stands among the others.
 */
export function otherTasksAnswer(db: Database, callerTaskId: string): OtherTasksAnswer {
  const ids = listTaskIds(db, null, TaskState.Active)
  const byId = new Map(getTasks(db, ids).map((task) => [task.id, task]))
  const all = ids.flatMap((id) => {
    const task = byId.get(id)
    return task === undefined ? [] : [task]
  })
  all.sort(byRecency)

  const flag: CutFlag = { cut: all.length > OTHER_TASKS_MAX }
  let bounded = all.slice(0, OTHER_TASKS_MAX)
  if (flag.cut && !bounded.some((task) => task.id === callerTaskId)) {
    const self = all.find((task) => task.id === callerTaskId)
    if (self !== undefined) bounded = [...bounded.slice(0, OTHER_TASKS_MAX - 1), self].sort(byRecency)
  }

  const workspaceNames = new Map(listWorkspaces(db).map((workspace) => [workspace.id, workspace.name]))
  const tasks = bounded.map((task) =>
    otherTaskOf(db, task, workspaceNames.get(task.workspaceId) ?? task.workspaceId, callerTaskId, flag),
  )
  return { tasks, cut: flag.cut }
}

/** `OtherTask.attention` in plain words, as the issue asks for it: "working", "needs you" or "idle". */
function attentionWord(attention: TaskAttention): string {
  switch (attention) {
    case TaskAttention.Working:
      return 'working'
    case TaskAttention.NeedsYou:
      return 'needs you'
    case TaskAttention.Idle:
      return 'idle'
  }
}

function linksText(links: readonly OtherTaskLink[]): string {
  if (links.length === 0) return 'none'
  return links.map((link) => `"${link.title}" ${link.url}`).join('; ')
}

function otherTaskText(task: OtherTask): string {
  const who = task.isSelf ? ' (this task, itself)' : ''
  const title = task.title === '' ? '(untitled)' : `"${task.title}"`
  return [
    `- ${task.id}${who}: ${title} — in ${task.workspace}, ${attentionWord(task.attention)}, updated ` +
      new Date(task.updatedAt).toISOString(),
    `  Goal: ${task.objective === '' ? '(not set)' : task.objective}`,
    `  Now: ${task.status === '' ? '(not set)' : task.status}`,
    `  Links: ${linksText(task.links)}`,
  ].join('\n')
}

/** What `list_other_tasks` tells the agent: a header, then a block per task, most recently updated first. */
export function otherTasksText(answer: OtherTasksAnswer): string {
  const { tasks, cut } = answer
  if (tasks.length === 0) return 'No other Active tasks right now.'
  const count = tasks.length === 1 ? '1 Active task' : `${String(tasks.length)} Active tasks`
  const header = `${count}, most recently updated first${cut ? ' (cut: some tasks, links or long fields were left out or shortened)' : ''}:`
  return [header, ...tasks.map(otherTaskText)].join('\n\n')
}
