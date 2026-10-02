import type { Migration } from '../migrate'

/**
 * Link artifacts (#407): a task's artifacts can be links (a GitHub PR or issue, a Jira ticket, any web page) as well as
 * files of its workspace.
 *
 * - `artifacts` is rebuilt with a `kind` (`file` or `link`) and a `url`: a file has a `path` and no `url`, a link a
 *   `url` (its normalised address, `checkArtifactUrl` in `src/shared/artifactLinks.ts`) and no `path`. Each is unique
 *   within its task, so declaring the same file or link again renames it rather than adding another. Only a file has
 *   a last-seen file time (`modified_at`) or is ever `missing`. Every artifact so far is a file, and keeps its rowid,
 *   which orders a task's artifacts by when they were declared. Nothing references `artifacts`, so it's rebuilt with
 *   foreign keys on.
 * - `artifact_filters`: which of its artifacts a task's Artifacts tab shows, Files or Links, one row per task you
 *   chose one for; without one it shows all. They go with their task.
 */
export const linkArtifactsMigration: Migration = {
  version: 48,
  name: 'Add link artifacts, and the Artifacts tab’s filter',
  up(db) {
    db.exec(`
      CREATE TABLE artifacts_with_links (
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('file', 'link')),
        path TEXT,
        url TEXT,
        title TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        modified_at INTEGER,
        missing INTEGER NOT NULL DEFAULT 0 CHECK (missing IN (0, 1)),
        CHECK (
          (kind = 'file' AND path IS NOT NULL AND url IS NULL)
          OR (kind = 'link' AND url IS NOT NULL AND path IS NULL AND modified_at IS NULL AND missing = 0)
        ),
        UNIQUE (task_id, path),
        UNIQUE (task_id, url)
      ) STRICT;

      INSERT INTO artifacts_with_links
        (rowid, task_id, kind, path, url, title, added_at, updated_at, modified_at, missing)
        SELECT rowid, task_id, 'file', path, NULL, title, added_at, updated_at, modified_at, missing FROM artifacts;

      DROP TABLE artifacts;
      ALTER TABLE artifacts_with_links RENAME TO artifacts;

      CREATE TABLE artifact_filters (
        task_id TEXT PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
        filter TEXT NOT NULL CHECK (filter IN ('files', 'links'))
      ) STRICT;
    `)
  },
}
