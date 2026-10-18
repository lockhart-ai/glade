/**
 * Telling an agent what changed about its linked issues and PRs (#682): one message per task per poll, one line per
 * changed link, delivered the way a broadcast is (`../tasks/deliver`) — started as the task's next turn when it's
 * idle, queued at the end of its own queue when it's busy.
 */
import { GithubLinkKind, type GithubLinkWatch } from '../../shared/githubWatch'
import { MessageSource } from '../../shared/domain'
import type { AgentRunner } from '../agent/runner'
import { deliverMessage } from '../tasks/deliver'

/** One link's change, ready to tell the agent about: its identity, for the line's label, and what changed. */
export interface LinkChange {
  readonly taskId: string
  readonly url: string
  readonly kind: GithubLinkKind
  readonly number: number
  readonly title: string
  /** Never empty: `diffLinkState`'s clauses for this link, in order. */
  readonly lines: readonly string[]
}

/** A link's own label: `PR #2537` or `Issue #7`. */
function linkLabel(change: Pick<LinkChange, 'kind' | 'number'>): string {
  return `${change.kind === GithubLinkKind.PullRequest ? 'PR' : 'Issue'} #${String(change.number)}`
}

/** One link's line: `PR #2537 Port the chat cases: CI failed (13/14); 2 new comments`. */
export function formatLinkChange(change: LinkChange): string {
  return `${linkLabel(change)} ${change.title}: ${change.lines.join('; ')}`
}

/** The whole message for one task's batch of changes, one line per link. */
export function formatWakeMessage(changes: readonly LinkChange[]): string {
  return ['GitHub:', ...changes.map((change) => `- ${formatLinkChange(change)}`)].join('\n')
}

/** `changes`, grouped by the task they're for, each task's in the order given. */
function byTask(changes: readonly LinkChange[]): ReadonlyMap<string, LinkChange[]> {
  const grouped = new Map<string, LinkChange[]>()
  for (const change of changes) {
    const forTask = grouped.get(change.taskId)
    if (forTask === undefined) grouped.set(change.taskId, [change])
    else forTask.push(change)
  }
  return grouped
}

/**
 * Tells every task with a change one message, batching its links into one (`formatWakeMessage`), through the queue
 * path every message that isn't typed into the input bar goes through. One task failing to take it (a `CommandFailure`
 * other than busy) doesn't stop the rest.
 */
export function wakeTasks(runner: Pick<AgentRunner, 'send' | 'queue'>, changes: readonly LinkChange[]): void {
  for (const [taskId, taskChanges] of byTask(changes)) {
    try {
      deliverMessage(runner, taskId, formatWakeMessage(taskChanges), MessageSource.Github)
    } catch {
      // The task is gone, or otherwise can't take it right now: its next poll tries again if it's still watched.
    }
  }
}

/** A `LinkChange` from a watched link's identity and the clauses `diffLinkState` found for it. */
export function linkChangeOf(
  watch: Pick<GithubLinkWatch, 'taskId' | 'url' | 'kind' | 'title'>,
  number: number,
  lines: readonly string[],
): LinkChange {
  return { taskId: watch.taskId, url: watch.url, kind: watch.kind, number, title: watch.title, lines }
}
