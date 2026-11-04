import type { Database } from 'better-sqlite3'
import type { Migration } from '../migrate'

/**
 * Adds `github_link_watches.mergeable` (#771): the last known mergeability of a watched pull request, so the
 * watcher can tell when one flips from mergeable to conflicting and back — which changes nothing else it polls
 * for, so before this it never told the task or woke its agent. The column holds `MERGEABLE` or `CONFLICTING` as
 * GitHub's APIs name them; an UNKNOWN answer is never stored (the last known one stands in its place), so null
 * reads as UNKNOWN: no answer yet. Every row from before this migration reads as UNKNOWN, which leaves its next
 * poll to establish the baseline silently rather than report a flip from an answer nobody has.
 */
export const prMergeableMigration: Migration = {
  version: 85,
  name: 'Add the last known mergeability of a watched pull request',
  up(db: Database) {
    db.exec("ALTER TABLE github_link_watches ADD COLUMN mergeable TEXT CHECK (mergeable IN ('MERGEABLE', 'CONFLICTING'))")
  },
}