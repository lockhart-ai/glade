import type { Migration } from '../migrate'

/**
 * Keeps the usage each task's agent was last told of mid-turn (#688): one row per task, the session and weekly
 * percentages and the OpenRouter spend its last threshold note named, null for a window or the spend it has never
 * been told of. It goes with the task — the note goes to its agent — and so is deleted with the task itself, and
 * survives a relaunch, so a note is never sent twice for the same threshold.
 */
export const usageNoteAnnouncementsMigration: Migration = {
  version: 78,
  name: 'Add the usage-note announcements',
  up(db) {
    db.exec(`
      CREATE TABLE usage_note_announcements (
        task_id TEXT PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
        session REAL,
        week REAL,
        open_router REAL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `)
  },
}
