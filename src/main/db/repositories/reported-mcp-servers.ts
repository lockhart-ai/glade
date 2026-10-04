/**
 * The MCP servers each workspace's sessions have reported (#515): what Settings' MCP servers lists offer under Add….
 * A session names its servers as each turn starts (`system/init`), and with each call of one's tools; Glade keeps the
 * ones it doesn't build itself, by the key their tools' names carry (`src/shared/mcpServers.ts`), under the name last
 * reported. Nothing here grants anything: it's only what there is to grant.
 */
import type { Database } from 'better-sqlite3'
import type { EpochMs } from '../../../shared/domain'
import type { ReportedMcpServer } from '../../../shared/mcpServers'
import { Row } from './rows'

const TABLE = 'reported_mcp_servers'

function parseReported(raw: unknown): ReportedMcpServer {
  const row = new Row(TABLE, raw)
  return { server: row.text('server'), name: row.text('name') }
}

/**
 * Keeps the servers a workspace's session reported: each one new to the workspace is added, and one reported under
 * another name takes it. Answers how many rows that changed: none when the workspace already had them all, as named.
 */
export function noteReportedServers(
  db: Database,
  workspaceId: string,
  servers: readonly ReportedMcpServer[],
  now: EpochMs = Date.now(),
): number {
  const note = db.prepare(
    `INSERT INTO ${TABLE} (workspace_id, server, name, reported_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (workspace_id, server) DO UPDATE SET name = excluded.name, reported_at = excluded.reported_at
      WHERE name <> excluded.name`,
  )
  return db.transaction((): number => {
    let changed = 0
    for (const { server, name } of servers) changed += note.run(workspaceId, server, name, now).changes
    return changed
  })()
}

/**
 * The servers reported in a workspace, by name; or, with no workspace (null), in any, each once under the name it was
 * last reported by: what the Glade-wide list offers.
 */
export function listReportedServers(db: Database, workspaceId: string | null): ReportedMcpServer[] {
  if (workspaceId !== null) {
    return db
      .prepare(`SELECT server, name FROM ${TABLE} WHERE workspace_id = ? ORDER BY name COLLATE NOCASE, server`)
      .all(workspaceId)
      .map(parseReported)
  }
  // The latest report of each server, whichever workspace made it.
  return db
    .prepare(
      `SELECT server, name FROM (
        SELECT server, name, row_number() OVER (PARTITION BY server ORDER BY reported_at DESC, rowid DESC) AS latest
        FROM ${TABLE}
      ) WHERE latest = 1 ORDER BY name COLLATE NOCASE, server`,
    )
    .all()
    .map(parseReported)
}
