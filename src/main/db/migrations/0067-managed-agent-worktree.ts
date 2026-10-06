import type { Migration } from '../migrate'

/** The worktree a dispatched child works in (`isolation: "worktree"`, #558), by name; null for one in the workspace root. */
export const managedAgentWorktreeMigration: Migration = {
  version: 67,
  name: 'Keep the worktree a dispatched child works in',
  up(db) {
    db.exec('ALTER TABLE managed_agents ADD COLUMN worktree TEXT')
  },
}
