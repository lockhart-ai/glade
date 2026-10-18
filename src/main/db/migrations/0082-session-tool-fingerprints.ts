import type { Migration } from '../migrate'

/**
 * Adds `session_tool_fingerprints` (#709): the fingerprint (`../../agent/tool-fingerprint`) of each of Glade's own
 * tools a task's session has last been told about — its name, description and input schema, taken together. A
 * session resumed across an update can keep Claude Code's own stale view of a tool it already knew (see the PR for
 * the spike on why), even though the call it names reaches the live, current server, so the session believes the
 * tool can't do what it now can. Checked and recorded alongside `session_context` (`./0027-task-backfills`), but
 * kept in its own table, one row per tool rather than a handful of fixed columns: which tools a session knows, and
 * how many there are, grows as Glade's own tools do.
 *
 * Nothing to backfill: a session with none of these rows for a tool is, correctly, a session that's never been
 * told its fingerprint — the same as a tool it's never seen, which is recorded the first time, not reported.
 */
export const sessionToolFingerprintsMigration: Migration = {
  version: 82,
  name: "Add a task's session's known tool fingerprints",
  up(db) {
    db.exec(`
      CREATE TABLE session_tool_fingerprints (
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        hash TEXT NOT NULL,
        PRIMARY KEY (task_id, tool_name)
      ) STRICT;
    `)
  },
}
