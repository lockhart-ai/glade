import type { Migration } from '../migrate'

/**
 * Adds `session_context.sandbox` (P15-07, #452): whether the task's session has been told it runs in the agent sandbox
 * and to ask with `request_access` (`SANDBOX_LINE` in `../../agent/system-prompt`). Claude Code keeps a session's
 * prompt when it resumes it, so a session that started before the sandbox was on, and resumes in it, is sent that
 * once, ahead of its next message. Every session recorded before this counts as not told: 0. One that did start
 * sandboxed is told once more, which costs a paragraph.
 */
export const sessionSandboxContextMigration: Migration = {
  version: 58,
  name: 'Add whether a session was told of the sandbox',
  up(db) {
    db.exec('ALTER TABLE session_context ADD COLUMN sandbox INTEGER NOT NULL DEFAULT 0 CHECK (sandbox IN (0, 1))')
  },
}
