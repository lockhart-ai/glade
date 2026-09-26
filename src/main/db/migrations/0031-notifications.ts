import type { Migration } from '../migrate'

/**
 * Adds the notifications Glade sent (`../repositories/notifications`): the menu bar popover's Recent section lists the
 * latest, with their age, so they're kept across a relaunch. Each keeps what it said (its title and the start of the
 * message), as it was when it was sent. Only the latest few are kept; a notification goes with its task.
 */
export const notificationsMigration: Migration = {
  version: 31,
  name: 'Add the notifications sent',
  up(db) {
    db.exec(`
      CREATE TABLE notifications (
        seq INTEGER PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        sent_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX notifications_task ON notifications (task_id);
    `)
  },
}
