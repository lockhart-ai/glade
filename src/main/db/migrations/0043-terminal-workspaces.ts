import type { Database } from 'better-sqlite3'
import type { Migration } from '../migrate'
import { Row } from '../repositories/rows'

/** The UI state key that held the one tab the bottom bar showed, before each workspace had its own tabs. */
const OLD_SELECTION_KEY = 'terminal_tab'

/** The UI state key that holds the tab each workspace's bottom bar shows (`UiStateKey.TerminalSelection`). */
const SELECTION_KEY = 'terminal_selection'

/** A workspace as this migration sees it. */
interface WorkspaceRoot {
  readonly id: string
  readonly rootPath: string
}

/** A terminal tab as this migration sees it. */
interface TabFolder {
  readonly id: string
  readonly cwd: string
}

/** Whether `path` is the folder `root` or inside it. */
export function isInFolder(path: string, root: string): boolean {
  if (path === root) return true
  const prefix = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(prefix)
}

/** The workspace whose root holds `cwd`, the deepest when roots nest; undefined when none does. */
export function workspaceHolding(workspaces: readonly WorkspaceRoot[], cwd: string): WorkspaceRoot | undefined {
  let found: WorkspaceRoot | undefined
  for (const workspace of workspaces) {
    if (!isInFolder(cwd, workspace.rootPath)) continue
    if (found === undefined || workspace.rootPath.length > found.rootPath.length) found = workspace
  }
  return found
}

function uiStateValue(db: Database, key: string): string | undefined {
  const raw: unknown = db.prepare('SELECT value FROM ui_state WHERE key = ?').get(key)
  return raw === undefined ? undefined : new Row('ui_state', raw).text('value')
}

/**
 * Gives each terminal tab a workspace (#347): the terminal was global, and is now per workspace. A tab's workspace is
 * the one whose root holds its folder (the deepest, when roots nest); a tab in no workspace's folder goes to the
 * workspace that was showing, or else the first one. With no workspace at all, a tab keeps none: the window with no
 * workspace open shows it. A tab goes with its workspace.
 *
 * The one tab the bottom bar showed (`terminal_tab`) becomes its workspace's entry in `terminal_selection`: JSON, from
 * a workspace's id (`''` for none) to the tab its bottom bar shows.
 */
export const terminalWorkspacesMigration: Migration = {
  version: 43,
  name: 'Give each terminal tab a workspace',
  up(db) {
    db.exec('ALTER TABLE terminal_tabs ADD COLUMN workspace_id TEXT REFERENCES workspaces (id) ON DELETE CASCADE')

    const workspaces = db
      .prepare('SELECT id, root_path FROM workspaces ORDER BY created_at, name, id')
      .all()
      .map((raw): WorkspaceRoot => {
        const row = new Row('workspaces', raw)
        return { id: row.text('id'), rootPath: row.text('root_path') }
      })
    const shownId = uiStateValue(db, 'active_workspace_id')
    const fallback = workspaces.find(({ id }) => id === shownId) ?? workspaces[0]
    const tabs = db
      .prepare('SELECT id, cwd FROM terminal_tabs')
      .all()
      .map((raw): TabFolder => {
        const row = new Row('terminal_tabs', raw)
        return { id: row.text('id'), cwd: row.text('cwd') }
      })
    const assign = db.prepare('UPDATE terminal_tabs SET workspace_id = ? WHERE id = ?')
    const assigned = new Map<string, string | null>()
    for (const tab of tabs) {
      const workspaceId = (workspaceHolding(workspaces, tab.cwd) ?? fallback)?.id ?? null
      assign.run(workspaceId, tab.id)
      assigned.set(tab.id, workspaceId)
    }

    const shownTab = uiStateValue(db, OLD_SELECTION_KEY)
    db.prepare('DELETE FROM ui_state WHERE key = ?').run(OLD_SELECTION_KEY)
    if (shownTab === undefined || !assigned.has(shownTab)) return
    const selection = { [assigned.get(shownTab) ?? '']: shownTab }
    db.prepare('INSERT INTO ui_state (key, value) VALUES (?, ?)').run(SELECTION_KEY, JSON.stringify(selection))
  },
}
