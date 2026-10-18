/**
 * The GitHub link watcher's own cache (#682, migration 0079): the last state fetched of each GitHub pull request or
 * issue a task has linked. One row per task and link, going with the link artifact it caches (`artifacts.task_id,
 * artifacts.url`), which goes with the task.
 */
import type { Database } from 'better-sqlite3'
import { GithubChecksState, GithubLinkKind, GithubLinkState, type GithubLinkWatch } from '../../../shared/githubWatch'
import type { EpochMs } from '../../../shared/domain'
import { Row } from './rows'

const COLUMNS =
  'task_id, url, kind, state, merged, draft, in_merge_queue, checks_state, checks_summary, review_state, ' +
  'comment_count, head_oid, title, watching, last_fetched_at'

const LINK_KINDS = Object.values(GithubLinkKind)
const LINK_STATES = Object.values(GithubLinkState)
const CHECKS_STATES = Object.values(GithubChecksState)

function parseWatch(raw: unknown): GithubLinkWatch {
  const row = new Row('github_link_watches', raw)
  return {
    taskId: row.text('task_id'),
    url: row.text('url'),
    kind: row.oneOf('kind', LINK_KINDS),
    state: row.oneOf('state', LINK_STATES),
    merged: row.flag('merged'),
    draft: row.flag('draft'),
    inMergeQueue: row.flag('in_merge_queue'),
    checksState: row.nullableOneOf('checks_state', CHECKS_STATES),
    checksSummary: row.nullableText('checks_summary'),
    reviewState: row.nullableText('review_state'),
    commentCount: row.integer('comment_count'),
    headOid: row.nullableText('head_oid'),
    title: row.text('title'),
    watching: row.flag('watching'),
    lastFetchedAt: row.integer('last_fetched_at'),
  }
}

/** A watch to declare or update, by its task and link: `taskId` and `url` must already be one of the task's link artifacts. */
export type NewGithubLinkWatch = Omit<GithubLinkWatch, 'lastFetchedAt'>

/**
 * Records what a poll found of one of a task's linked issues or PRs, replacing what it had. Answers with the watch as
 * it now is. Throws a foreign key error for a `taskId`/`url` that isn't one of the task's link artifacts.
 */
export function putGithubLinkWatch(
  db: Database,
  watch: NewGithubLinkWatch,
  now: EpochMs = Date.now(),
): GithubLinkWatch {
  const raw: unknown = db
    .prepare(
      `INSERT INTO github_link_watches (${COLUMNS})
      VALUES (@taskId, @url, @kind, @state, @merged, @draft, @inMergeQueue, @checksState, @checksSummary,
        @reviewState, @commentCount, @headOid, @title, @watching, @lastFetchedAt)
      ON CONFLICT (task_id, url) DO UPDATE SET
        kind = excluded.kind, state = excluded.state, merged = excluded.merged, draft = excluded.draft,
        in_merge_queue = excluded.in_merge_queue, checks_state = excluded.checks_state,
        checks_summary = excluded.checks_summary, review_state = excluded.review_state,
        comment_count = excluded.comment_count, head_oid = excluded.head_oid, title = excluded.title,
        watching = excluded.watching, last_fetched_at = excluded.last_fetched_at
      RETURNING ${COLUMNS}`,
    )
    .get({
      ...watch,
      merged: watch.merged ? 1 : 0,
      draft: watch.draft ? 1 : 0,
      inMergeQueue: watch.inMergeQueue ? 1 : 0,
      watching: watch.watching ? 1 : 0,
      lastFetchedAt: now,
    })
  return parseWatch(raw)
}

/** One of a task's watched links, by its url; undefined when it has no cached state yet. */
export function getGithubLinkWatch(db: Database, taskId: string, url: string): GithubLinkWatch | undefined {
  const raw: unknown = db
    .prepare(`SELECT ${COLUMNS} FROM github_link_watches WHERE task_id = ? AND url = ?`)
    .get(taskId, url)
  return raw === undefined ? undefined : parseWatch(raw)
}

/** A task's cached links, in no particular order. */
export function listGithubLinkWatches(db: Database, taskId: string): GithubLinkWatch[] {
  return db.prepare(`SELECT ${COLUMNS} FROM github_link_watches WHERE task_id = ?`).all(taskId).map(parseWatch)
}

/** Every link still being watched, across every task, in no particular order: what the next poll checks. */
export function listWatchedLinks(db: Database): GithubLinkWatch[] {
  return db.prepare(`SELECT ${COLUMNS} FROM github_link_watches WHERE watching = 1`).all().map(parseWatch)
}
