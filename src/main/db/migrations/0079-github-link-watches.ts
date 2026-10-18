import type { Migration } from '../migrate'

/**
 * The GitHub link watcher's own cache (#682): the last state seen of each link artifact that's a GitHub pull request
 * or issue (`recogniseLink` in `src/shared/artifactLinks.ts`), one row per task and link. `kind`, `state`, `merged`,
 * `draft` and `in_merge_queue` say what the issue or PR itself is doing now; `checks_state`/`checks_summary`,
 * `review_state`, `comment_count` and `head_oid` are what a later poll compares against to tell the agent what
 * changed. `title` is GitHub's own title, for the wake message, not the artifact's own (which you may have renamed).
 * `watching` turns to 0 once the link stops being polled (its todo is done, or the issue/PR closed or merged,
 * whichever is first), but the row stays: PR #683's richer link rows still show the last state seen. Goes with its
 * link artifact (`artifacts.task_id, artifacts.url`), which goes with its task.
 */
export const githubLinkWatchesMigration: Migration = {
  version: 79,
  name: "Add the GitHub link watcher's cache of each link's last known state",
  up(db) {
    db.exec(`
      CREATE TABLE github_link_watches (
        task_id TEXT NOT NULL,
        url TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('issue', 'pull_request')),
        state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
        merged INTEGER NOT NULL DEFAULT 0 CHECK (merged IN (0, 1)),
        draft INTEGER NOT NULL DEFAULT 0 CHECK (draft IN (0, 1)),
        in_merge_queue INTEGER NOT NULL DEFAULT 0 CHECK (in_merge_queue IN (0, 1)),
        checks_state TEXT CHECK (checks_state IN ('success', 'failure', 'pending')),
        checks_summary TEXT,
        review_state TEXT,
        comment_count INTEGER NOT NULL DEFAULT 0,
        head_oid TEXT,
        title TEXT NOT NULL,
        watching INTEGER NOT NULL DEFAULT 1 CHECK (watching IN (0, 1)),
        last_fetched_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, url),
        FOREIGN KEY (task_id, url) REFERENCES artifacts (task_id, url) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX github_link_watches_watching ON github_link_watches (watching);
    `)
  },
}
