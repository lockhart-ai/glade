import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { EpochMs, TaskCommit } from '../../../shared/domain'
import { Row } from './rows'

/** How Glade knows a task made a commit. */
export enum CommitSource {
  /** The commit's hash was in what the task's `Bash` call printed (`[main a1b2c3d] …`). */
  Printed = 'printed',
  /** The working tree's `HEAD` moved to it, as a commit, while the task's `Bash` call ran. */
  Observed = 'observed',
}

/** A commit a task made, as Glade links it to the task. */
export interface NewTaskCommit {
  readonly taskId: string
  /** The repository's common git dir: where its objects are, worktree or not. */
  readonly gitDir: string
  /** The working tree it was made in. */
  readonly repoPath: string
  readonly hash: string
  readonly subject: string
  readonly branch: string | null
  readonly committedAt: EpochMs
  readonly additions: number
  readonly deletions: number
  readonly filesChanged: number
  /** How many parents it has: more than one for a merge. */
  readonly parents: number
  /** The `Bash` call that made it; null when that isn't known. */
  readonly toolUseId: string | null
  readonly source: CommitSource
}

/** A task's link to a commit, as it's kept. */
export interface StoredTaskCommit extends NewTaskCommit {
  readonly id: string
  readonly attributedAt: EpochMs
}

/** Who a commit is linked to now, and how it came to be. */
export interface CommitOwner {
  readonly taskId: string
  readonly toolUseId: string | null
  readonly source: CommitSource
  readonly branch: string | null
}

const COLUMNS = `id, task_id, git_dir, repo_path, hash, subject, branch, committed_at, additions, deletions,
  files_changed, parents, tool_use_id, source, attributed_at`

function parseStored(row: Row): StoredTaskCommit {
  return {
    id: row.text('id'),
    taskId: row.text('task_id'),
    gitDir: row.text('git_dir'),
    repoPath: row.text('repo_path'),
    hash: row.text('hash'),
    subject: row.text('subject'),
    branch: row.nullableText('branch'),
    committedAt: row.integer('committed_at'),
    additions: row.integer('additions'),
    deletions: row.integer('deletions'),
    filesChanged: row.integer('files_changed'),
    parents: row.integer('parents'),
    toolUseId: row.nullableText('tool_use_id'),
    source: row.oneOf('source', Object.values(CommitSource)),
    attributedAt: row.integer('attributed_at'),
  }
}

function parseRaw(raw: unknown): StoredTaskCommit {
  return parseStored(new Row('task_commits', raw))
}

/** Links a commit to a task; answers with the link. The commit must be no task's yet. */
export function addTaskCommit(db: Database, commit: NewTaskCommit, now: EpochMs = Date.now()): StoredTaskCommit {
  const id = randomUUID()
  db.prepare(`INSERT INTO task_commits (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    commit.taskId,
    commit.gitDir,
    commit.repoPath,
    commit.hash,
    commit.subject,
    commit.branch,
    commit.committedAt,
    commit.additions,
    commit.deletions,
    commit.filesChanged,
    commit.parents,
    commit.toolUseId,
    commit.source,
    now,
  )
  return { ...commit, id, attributedAt: now }
}

/** The link to a commit, whichever task has it; undefined when no task does. */
export function findTaskCommit(db: Database, gitDir: string, hash: string): StoredTaskCommit | undefined {
  const raw: unknown = db
    .prepare(`SELECT ${COLUMNS} FROM task_commits WHERE git_dir = ? AND hash = ?`)
    .get(gitDir, hash)
  return raw === undefined ? undefined : parseRaw(raw)
}

export function getTaskCommit(db: Database, id: string): StoredTaskCommit | undefined {
  const raw: unknown = db.prepare(`SELECT ${COLUMNS} FROM task_commits WHERE id = ?`).get(id)
  return raw === undefined ? undefined : parseRaw(raw)
}

/** Gives a commit to another task, or the same task by another call. */
export function reassignTaskCommit(db: Database, id: string, owner: CommitOwner): void {
  db.prepare('UPDATE task_commits SET task_id = ?, tool_use_id = ?, source = ?, branch = ? WHERE id = ?').run(
    owner.taskId,
    owner.toolUseId,
    owner.source,
    owner.branch,
    id,
  )
}

export function removeTaskCommit(db: Database, id: string): void {
  db.prepare('DELETE FROM task_commits WHERE id = ?').run(id)
}

/**
 * A task's commits, newest first (by when they were committed; of those made in the same second, the one linked last
 * first), as the Changes tab lists them: each with the subagent that made it, from the tool log (the parent of the
 * `Bash` call that made it).
 */
export function listTaskCommits(db: Database, taskId: string): TaskCommit[] {
  const rows: unknown[] = db
    .prepare(
      `SELECT c.id, c.task_id, c.repo_path, c.hash, c.subject, c.branch, c.committed_at, c.additions, c.deletions,
        c.files_changed, c.parents, e.parent_tool_use_id AS subagent
      FROM task_commits c
      LEFT JOIN tool_events e ON e.task_id = c.task_id AND e.tool_use_id = c.tool_use_id AND e.kind = 'tool_call'
      WHERE c.task_id = ?
      ORDER BY c.committed_at DESC, c.rowid DESC`,
    )
    .all(taskId)
  return rows.map((raw) => {
    const row = new Row('task_commits', raw)
    return {
      id: row.text('id'),
      taskId: row.text('task_id'),
      hash: row.text('hash'),
      subject: row.text('subject'),
      branch: row.nullableText('branch'),
      committedAt: row.integer('committed_at'),
      additions: row.integer('additions'),
      deletions: row.integer('deletions'),
      filesChanged: row.integer('files_changed'),
      merge: row.integer('parents') > 1,
      repoPath: row.text('repo_path'),
      subagentToolUseId: row.nullableText('subagent'),
    }
  })
}
