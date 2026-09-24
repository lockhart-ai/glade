import type { Migration } from '../migrate'

/**
 * Adds the global terminal's tabs (`TerminalTab` in `src/shared/terminal.ts`), in the tab row's order: the name you
 * gave each (null for the default), the folder its shell started in, and the recent output it last showed, so a
 * relaunch can show it again above a new shell. Processes don't survive a restart; the output does.
 */
export const terminalTabsMigration: Migration = {
  version: 19,
  name: 'Add the terminal tabs',
  up(db) {
    db.exec(`
      CREATE TABLE terminal_tabs (
        id TEXT PRIMARY KEY,
        name TEXT,
        cwd TEXT NOT NULL,
        position INTEGER NOT NULL,
        scrollback TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      ) STRICT;
    `)
  },
}
