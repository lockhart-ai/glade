import { expect, it } from 'vitest'
import { ArtifactKind } from '../../../shared/domain'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { addLinkArtifact, removeArtifact } from '../repositories/artifacts'
import { MIGRATIONS } from '.'
import { githubLinkWatchesMigration } from './0079-github-link-watches'

const URL = 'https://github.com/acme/api/pull/412'

it('is migration 79, after every earlier one', () => {
  expect(githubLinkWatchesMigration.version).toBe(79)
  expect(MIGRATIONS.indexOf(githubLinkWatchesMigration)).toBe(MIGRATIONS.filter((m) => m.version < 79).length)
})

function seeded() {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS)
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()
  addLinkArtifact(db, { taskId: 't', url: URL, title: '#412' })
  return db
}

const insertWatch = (db: ReturnType<typeof seeded>) =>
  db
    .prepare(
      `INSERT INTO github_link_watches
        (task_id, url, kind, state, merged, draft, in_merge_queue, checks_state, checks_summary, review_state,
         comment_count, head_oid, title, watching, last_fetched_at)
      VALUES ('t', ?, 'pull_request', 'open', 0, 0, 0, 'pending', NULL, NULL, 0, 'abc123', 'Port the chat cases', 1, 10)`,
    )
    .run(URL)

it('goes with its link artifact: removing it, or its task, drops the watch row too', () => {
  const db = seeded()
  insertWatch(db)
  expect(db.prepare('SELECT COUNT(*) FROM github_link_watches').pluck().get()).toBe(1)

  removeArtifact(db, 't', { kind: ArtifactKind.Link, url: URL })
  expect(db.prepare('SELECT COUNT(*) FROM github_link_watches').pluck().get()).toBe(0)

  insertWatch2(db)
  db.prepare("DELETE FROM tasks WHERE id = 't'").run()
  expect(db.prepare('SELECT COUNT(*) FROM github_link_watches').pluck().get()).toBe(0)
  expect(db.pragma('foreign_key_check')).toEqual([])
  db.close()
})

function insertWatch2(db: ReturnType<typeof seeded>): void {
  addLinkArtifact(db, { taskId: 't', url: URL, title: '#412' })
  insertWatch(db)
}

it('refuses a row for a URL that is not one of the task’s link artifacts', () => {
  const db = seeded()
  expect(() =>
    db
      .prepare(
        `INSERT INTO github_link_watches
          (task_id, url, kind, state, merged, draft, in_merge_queue, comment_count, title, watching, last_fetched_at)
        VALUES ('t', 'https://github.com/acme/api/pull/999', 'pull_request', 'open', 0, 0, 0, 0, 'Not linked', 1, 10)`,
      )
      .run(),
  ).toThrow(/FOREIGN KEY/)
  db.close()
})

it('refuses a kind, state or checks state outside what it knows', () => {
  const db = seeded()
  insertWatch(db)
  expect(() => db.prepare(`UPDATE github_link_watches SET kind = 'ticket' WHERE url = ?`).run(URL)).toThrow(/CHECK/)
  expect(() => db.prepare(`UPDATE github_link_watches SET state = 'merged' WHERE url = ?`).run(URL)).toThrow(/CHECK/)
  expect(() => db.prepare(`UPDATE github_link_watches SET checks_state = 'queued' WHERE url = ?`).run(URL)).toThrow(
    /CHECK/,
  )
  db.close()
})
