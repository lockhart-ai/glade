/**
 * Which of a task's link artifacts the GitHub link watcher polls (#682): every one that's a GitHub pull request or
 * issue (`recogniseLink`, no network needed to tell), across every active task, with the state last fetched for it
 * (if any) and whether its todo is done now. The poller decides from the stored state which to fetch (#738): one
 * never fetched or still open, whatever its todo says; a merged or closed one never again.
 */
import type { Database } from 'better-sqlite3'
import { ArtifactKind, TaskState, TodoState, type EpochMs } from '../../shared/domain'
import { LinkKind, recogniseLink } from '../../shared/artifactLinks'
import { GithubLinkKind, type GithubLinkWatch } from '../../shared/githubWatch'
import { childOfArtifact } from '../../shared/todoHub'
import { listArtifacts } from '../db/repositories/artifacts'
import { listFilings } from '../db/repositories/child-filings'
import { getGithubLinkWatch } from '../db/repositories/github-link-watches'
import { getTodo } from '../db/repositories/glade-todos'
import { listTaskIds } from '../db/repositories/tasks'
import type { WatchTarget } from './query'

/** One link worth considering this poll: what to ask GitHub, what was known of it before, and whether it may wake. */
export interface WatchCandidate {
  readonly target: WatchTarget
  readonly previous: GithubLinkWatch | undefined
  /** When the link artifact was added to the task: a first fetch tells a merge or close after it from one before (#728). */
  readonly linkedAt: EpochMs
  /** True when the link's filing has its todo marked done now: still fetched (#738), but its changes never wake the task. */
  readonly todoDone: boolean
}

/** `owner/repo` split in two, as `RecognisedLink.repo` has it. */
function splitRepo(repo: string): { owner: string; name: string } {
  const [owner = '', name = ''] = repo.split('/')
  return { owner, name }
}

/** Whether the link's filing has its todo marked done, right now. False when it isn't filed: nothing says it's done. */
function todoIsDone(db: Database, taskId: string, url: string): boolean {
  const child = childOfArtifact({ kind: ArtifactKind.Link, url })
  const filing = listFilings(db, taskId).find(({ kind, key }) => kind === child.kind && key === child.key)
  if (filing === undefined) return false
  return getTodo(db, taskId, filing.todoId)?.state === TodoState.Done
}

/**
 * Every link worth considering across every active task: one entry per link artifact `recogniseLink` reads as a
 * GitHub pull request or issue, whatever was last fetched for it — the poller decides from the stored state which
 * to fetch and which to leave (#738).
 */
export function watchCandidates(db: Database): WatchCandidate[] {
  const candidates: WatchCandidate[] = []
  for (const taskId of listTaskIds(db, null, TaskState.Active)) {
    for (const artifact of listArtifacts(db, taskId)) {
      if (artifact.kind !== ArtifactKind.Link) continue
      const recognised = recogniseLink(artifact.url)
      if (recognised.kind !== LinkKind.PullRequest && recognised.kind !== LinkKind.Issue) continue
      const previous = getGithubLinkWatch(db, taskId, artifact.url)
      const { owner, name } = splitRepo(recognised.repo)
      candidates.push({
        target: {
          taskId,
          url: artifact.url,
          owner,
          repo: name,
          number: recognised.number,
          kind: recognised.kind === LinkKind.PullRequest ? GithubLinkKind.PullRequest : GithubLinkKind.Issue,
        },
        previous,
        linkedAt: artifact.addedAt,
        todoDone: todoIsDone(db, taskId, artifact.url),
      })
    }
  }
  return candidates
}
