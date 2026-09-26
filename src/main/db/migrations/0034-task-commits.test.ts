import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { listTaskCommits } from '../repositories/task-commits'
import { MIGRATIONS } from '.'
import { taskCommitsMigration } from './0034-task-commits'

it('is migration 34, after every earlier one', () => {
  expect(taskCommitsMigration.version).toBe(34)
  expect(MIGRATIONS.filter((m) => m.version > 34)).toEqual([])
  expect(MIGRATIONS).toContain(taskCommitsMigration)
})

it('starts every existing task with no commits, keeps one link per commit, checks its source, and drops them with their task', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((m) => m.version < 34),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()

  migrate(db, MIGRATIONS)

  expect(listTaskCommits(db, 't')).toEqual([])
  const insert = (id: string, hash: string, source: string) =>
    db
      .prepare(
        `INSERT INTO task_commits (id, task_id, git_dir, repo_path, hash, subject, branch, committed_at, additions,
          deletions, files_changed, parents, tool_use_id, source, attributed_at)
        VALUES (?, 't', '/code/acme-api/.git', '/code/acme-api', ?, 'Fix', 'main', 1, 1, 1, 1, 2, 'toolu_1', ?, 1)`,
      )
      .run(id, hash, source)
  insert('a', 'a'.repeat(40), 'printed')
  expect(listTaskCommits(db, 't')).toMatchObject([{ id: 'a', merge: true, subagentToolUseId: null }])
  expect(() => insert('b', 'a'.repeat(40), 'observed')).toThrow(/UNIQUE/)
  expect(() => insert('c', 'c'.repeat(40), 'guessed')).toThrow(/CHECK/)
  db.prepare("DELETE FROM tasks WHERE id = 't'").run()
  expect(db.prepare('SELECT COUNT(*) FROM task_commits').pluck().get()).toBe(0)
  db.close()
})
