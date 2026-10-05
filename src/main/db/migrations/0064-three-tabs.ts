import type { Migration } from '../migrate'

/** The right panel's tabs from before it had three, as UI state stored them. */
const REMOVED_TABS = "'tool-calls', 'subagents', 'watchers', 'artifacts', 'changes'"

/**
 * The right panel is Agents · Files · Todos for everyone (P16, #501): takes out what only the tabs that went, and the
 * switch the phase was built behind, had stored.
 *
 * - `artifact_groups` and `artifact_filters`: the date groups you'd opened or folded in the Artifacts tab, and its
 *   Files or Links filter. A todo's panel remembers its own filter now (`todo_panels`), so both tables go.
 * - `settings.todoHubEnabled`: the hidden switch. The hub is on for every task, whatever was stored, so its row goes.
 * - `ui_state`: a workspace remembered on Tool calls, Subagents, Watchers, Artifacts or Changes is forgotten, so it
 *   opens on Agents: the one tab every workspace shared before each had its own (`right_panel_tab`), and each
 *   workspace's own (`right_panel_tabs`, a JSON object from workspace id to tab).
 *
 * Nothing a task produced is touched: its artifacts, commits, subagents and watchers are where they were, and what was
 * filed under no todo before the hub shows under "Not under a todo".
 */
export const threeTabsMigration: Migration = {
  version: 64,
  name: 'Drop what the removed panel tabs stored, and the todo hub’s switch',
  up(db) {
    db.exec(`
      DROP TABLE artifact_groups;
      DROP TABLE artifact_filters;
      DELETE FROM settings WHERE key = 'todoHubEnabled';
      DELETE FROM ui_state WHERE key = 'right_panel_tab' AND value IN (${REMOVED_TABS});
      UPDATE ui_state
      SET value = (
        SELECT json_group_object(tabs.key, tabs.value)
        FROM json_each(ui_state.value) AS tabs
        WHERE tabs.value NOT IN (${REMOVED_TABS})
      )
      WHERE key = 'right_panel_tabs' AND json_valid(value) AND json_type(value) = 'object';
    `)
  },
}
