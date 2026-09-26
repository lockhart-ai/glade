import type { Migration } from '../migrate'

/**
 * Adds `session_context.instruction_updates` (#301): how many of the instructions Glade added to its prompt since
 * sessions first started with it (`INSTRUCTION_UPDATES` in `../../agent/system-prompt`) the task's session has. Claude
 * Code keeps a session's prompt when it resumes it, so the ones it hasn't had go to it once, ahead of the next message.
 * Every session recorded before this has none of them: 0.
 */
export const instructionUpdatesMigration: Migration = {
  version: 40,
  name: 'Add the instruction updates a session has',
  up(db) {
    db.exec(
      'ALTER TABLE session_context ADD COLUMN instruction_updates INTEGER NOT NULL DEFAULT 0 CHECK (instruction_updates >= 0)',
    )
  },
}
