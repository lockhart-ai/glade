import type { Migration } from '../migrate'

/**
 * Adds the note a limit-switch leaves a task (#564): what background work the switch stopped, prepended once to the
 * destination session's next prompt. It was held on the live session in memory only, so a relaunch between the switch
 * and the next prompt lost it. The note goes with the task — the session it waits for is the task's — and so lives on
 * its own row, deleted once the note has been given and with the task itself.
 */
export const stoppedWorkNoteMigration: Migration = {
  version: 77,
  name: 'Add the stopped-work notes',
  up(db) {
    db.exec(`
      CREATE TABLE stopped_work_notes (
        task_id TEXT PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
        note TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `)
  },
}
