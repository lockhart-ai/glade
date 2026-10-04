import type { Migration } from '../migrate'

/**
 * Adds two kinds of sandbox grant (P15-11, #515; `McpServerGrant` and `AgentsGrant` in `src/shared/sandbox.ts`), and
 * the MCP servers each workspace's sessions have reported.
 *
 * - `sandbox_grants.kind` gains `mcp_server` (an MCP server Glade doesn't build: `value` is the server as its tools'
 *   names carry it, `name` the name Claude Code reported it by, for showing) and `agents` (other agents a tool of
 *   Claude Code's own reaches: `value` is `sessions` or `cloud`). Allowing them changes the table's CHECKs, which means
 *   rebuilding the table; nothing references `sandbox_grants`, so its rows are copied across in the order they were
 *   granted. `name` is set for an MCP server and null for every other grant, as every grant made before this is.
 * - `reported_mcp_servers`: a server a workspace's sessions have named (`system/init`'s `mcp_servers`, or a call of
 *   one of its tools), other than Glade's own in-process ones: what Settings' Add… offers, by name. One row per server
 *   in each workspace, under the name it was last reported by; they go with the workspace.
 */
export const mcpServerGrantsMigration: Migration = {
  version: 60,
  name: 'Add MCP servers and other agents to the sandbox grants',
  up(db) {
    db.exec(`
      CREATE TABLE sandbox_grants_next (
        scope TEXT NOT NULL CHECK (scope IN ('glade', 'workspace', 'task')),
        workspace_id TEXT REFERENCES workspaces (id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks (id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('folder', 'domain', 'mcp_server', 'agents')),
        value TEXT NOT NULL CHECK (value <> ''),
        access TEXT,
        created_at INTEGER NOT NULL,
        is_file INTEGER NOT NULL DEFAULT 0 CHECK (is_file IN (0, 1) AND (kind = 'folder' OR is_file = 0)),
        name TEXT,
        CHECK (
          (scope = 'glade' AND workspace_id IS NULL AND task_id IS NULL)
          OR (scope = 'workspace' AND workspace_id IS NOT NULL AND task_id IS NULL)
          OR (scope = 'task' AND task_id IS NOT NULL AND workspace_id IS NULL)
        ),
        CHECK (
          (kind = 'folder' AND access IS NOT NULL AND access IN ('read', 'read_write'))
          OR (kind <> 'folder' AND access IS NULL)
        ),
        CHECK ((kind = 'mcp_server' AND name IS NOT NULL AND name <> '') OR (kind <> 'mcp_server' AND name IS NULL)),
        CHECK (kind <> 'agents' OR value IN ('sessions', 'cloud'))
      ) STRICT;

      INSERT INTO sandbox_grants_next (scope, workspace_id, task_id, kind, value, access, created_at, is_file)
        SELECT scope, workspace_id, task_id, kind, value, access, created_at, is_file
        FROM sandbox_grants ORDER BY rowid;
      DROP TABLE sandbox_grants;
      ALTER TABLE sandbox_grants_next RENAME TO sandbox_grants;

      CREATE UNIQUE INDEX sandbox_grants_by_scope
        ON sandbox_grants (scope, ifnull(workspace_id, ''), ifnull(task_id, ''), kind, value);
      CREATE INDEX sandbox_grants_by_workspace ON sandbox_grants (workspace_id) WHERE workspace_id IS NOT NULL;
      CREATE INDEX sandbox_grants_by_task ON sandbox_grants (task_id) WHERE task_id IS NOT NULL;

      CREATE TABLE reported_mcp_servers (
        workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        server TEXT NOT NULL CHECK (server <> ''),
        name TEXT NOT NULL CHECK (name <> ''),
        reported_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, server)
      ) STRICT;
    `)
  },
}
