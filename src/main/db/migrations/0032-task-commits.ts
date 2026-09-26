import type { Migration } from '../migrate'

/**
 * Adds the commits each task made, for the Changes tab: a link from the task to a commit, one per commit, with what the
 * tab's row shows of it (read from git when the task made it, so the list needs no git to show) and where it is:
 * `git_dir` is the repository's common git dir, which every worktree shares, so the commit's files can still be read
 * after its worktree is removed; `repo_path` is the working tree it was made in. `tool_use_id` is the `Bash` call that
 * made it, which says whether a subagent did. `source` is how Glade knows the task made it: the commit's hash in what
 * the call printed, or its `HEAD` moving while the call ran (`docs/sdk-notes.md` §14). A commit is one task's at most
 * (`UNIQUE (git_dir, hash)`). A link goes with its task.
 */
export const taskCommitsMigration: Migration = {
  version: 32,
  name: 'Add the commits each task made',
  up(db) {
    db.exec(`
      CREATE TABLE task_commits (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        git_dir TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        hash TEXT NOT NULL,
        subject TEXT NOT NULL,
        branch TEXT,
        committed_at INTEGER NOT NULL,
        additions INTEGER NOT NULL,
        deletions INTEGER NOT NULL,
        files_changed INTEGER NOT NULL,
        parents INTEGER NOT NULL,
        tool_use_id TEXT,
        source TEXT NOT NULL CHECK (source IN ('printed', 'observed')),
        attributed_at INTEGER NOT NULL,
        UNIQUE (git_dir, hash)
      ) STRICT;

      CREATE INDEX task_commits_task ON task_commits (task_id, committed_at);
    `)
  },
}
