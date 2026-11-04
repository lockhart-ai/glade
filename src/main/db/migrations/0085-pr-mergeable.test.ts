import { expect, it } from 'vitest'
import { GithubLinkKind, GithubLinkState, PrMergeable } from '../../../shared/githubWatch'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { addLinkArtifact } from '../repositories/artifacts'
import { getGithubLinkWatch, putGithubLinkWatch } from '../repositories/github-link-watches'
import { MIGRATIONS } from '.'
import { prMergeableMigration } from './0085-pr-mergeable'

const URL = 'https://github.com/acme/api/pull/412'

it('is migration 85, after every earlier one', () => {
  expect(prMergeableMigration.version).toBe(85)
  expect(MIGRATIONS.indexOf(prMergeableMigration)).toBe(MIGRATIONS.filter((m) => m.version < 85).length)
})

/** A database as it stood at 84: a watch row for a linked PR, with no mergeability known of it. */
function seeded() {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 85),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()
  addLinkArtifact(db, { taskId: 't', url: URL, title: '#412' })
  db.prepare(
    `INSERT INTO github_link_watches
      (task_id, url, kind, state, merged, draft, in_merge_queue, checks_state, checks_summary, review_state,
       comment_count, head_oid, title, watching, last_fetched_at)
    VALUES ('t', ?, 'pull_request', 'open', 0, 0, 0, 'pending', NULL, NULL, 0, 'abc123', 'Port the chat cases', 1, 10)`,
  ).run(URL)
  return db
}

it('gives every row from before it no known mergeability, which the next poll establishes silently (#771)', () => {
  const db = seeded()

  migrate(db, MIGRATIONS)

  expect(getGithubLinkWatch(db, 't', URL)?.mergeable).toBeNull()
  db.close()
})

it('keeps the last known mergeability, and refuses anything but the two answers or none', () => {
  const db = seeded()
  migrate(db, MIGRATIONS)

  putGithubLinkWatch(db, {
    taskId: 't',
    url: URL,
    kind: GithubLinkKind.PullRequest,
    state: GithubLinkState.Open,
    merged: false,
    draft: false,
    inMergeQueue: false,
    checksState: null,
    checksSummary: null,
    reviewState: null,
    mergeable: PrMergeable.Conflicting,
    commentCount: 0,
    headOid: 'abc123',
    title: 'Port the chat cases',
    watching: true,
  })
  expect(getGithubLinkWatch(db, 't', URL)?.mergeable).toBe(PrMergeable.Conflicting)
  putGithubLinkWatch(db, {
    taskId: 't',
    url: URL,
    kind: GithubLinkKind.PullRequest,
    state: GithubLinkState.Open,
    merged: false,
    draft: false,
    inMergeQueue: false,
    checksState: null,
    checksSummary: null,
    reviewState: null,
    mergeable: PrMergeable.Mergeable,
    commentCount: 0,
    headOid: 'abc123',
    title: 'Port the chat cases',
    watching: true,
  })
  expect(getGithubLinkWatch(db, 't', URL)?.mergeable).toBe(PrMergeable.Mergeable)

  expect(() => db.prepare(`UPDATE github_link_watches SET mergeable = 'UNKNOWN' WHERE url = ?`).run(URL)).toThrow(
    /CHECK/,
  )
  db.close()
})
