import { expect, it } from 'vitest'
import { FolderAccess, OtherAgents, SandboxGrantKind, SandboxGrantScope } from '../../../shared/sandbox'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { listReportedServers, noteReportedServers } from '../repositories/reported-mcp-servers'
import { addSandboxGrant, listSandboxGrants } from '../repositories/sandbox-grants'
import { createWorkspace, deleteWorkspace } from '../repositories/workspaces'
import { MIGRATIONS } from '.'
import { mcpServerGrantsMigration } from './0060-mcp-server-grants'

const GLADE = { scope: SandboxGrantScope.Glade } as const

it('is migration 60, after every earlier one', () => {
  expect(mcpServerGrantsMigration.version).toBe(60)
  expect(MIGRATIONS.indexOf(mcpServerGrantsMigration)).toBe(MIGRATIONS.filter((m) => m.version < 60).length)
})

it('keeps every grant made before it, as it was and in the order it was granted', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 60),
  )
  const workspace = createWorkspace(db, { name: 'Acme API', rootPath: '/code/acme-api' }, 1)
  // Granted out of time order, and one of them a single file: the order they were saved in is the tie-break.
  db.prepare(
    `INSERT INTO sandbox_grants (scope, workspace_id, task_id, kind, value, access, created_at, is_file)
    VALUES ('glade', NULL, NULL, 'folder', '/Users/me/code/acme-web', 'read_write', 5, 0),
      ('glade', NULL, NULL, 'domain', 'registry.npmjs.org', NULL, 5, 0),
      ('glade', NULL, NULL, 'folder', '/Users/me/.gitconfig', 'read', 5, 1),
      ('workspace', ?, NULL, 'domain', 'docs.acme.dev', NULL, 2, 0)`,
  ).run(workspace.id)

  migrate(db, MIGRATIONS)

  expect(listSandboxGrants(db, GLADE).map(({ grant }) => grant)).toEqual([
    { kind: SandboxGrantKind.Folder, path: '/Users/me/code/acme-web', access: FolderAccess.ReadWrite },
    { kind: SandboxGrantKind.Domain, domain: 'registry.npmjs.org' },
    { kind: SandboxGrantKind.Folder, path: '/Users/me/.gitconfig', access: FolderAccess.Read, file: true },
  ])
  expect(
    listSandboxGrants(db, { scope: SandboxGrantScope.Workspace, workspaceId: workspace.id }).map(({ grant }) => grant),
  ).toEqual([{ kind: SandboxGrantKind.Domain, domain: 'docs.acme.dev' }])
  // One grant of each folder or domain in a scope, still.
  expect(() =>
    db
      .prepare(
        `INSERT INTO sandbox_grants (scope, kind, value, access, created_at)
        VALUES ('glade', 'domain', 'registry.npmjs.org', NULL, 9)`,
      )
      .run(),
  ).toThrow(/UNIQUE/)
  // And a workspace's grants still go with it.
  deleteWorkspace(db, workspace.id)
  expect(db.prepare('SELECT count(*) AS n FROM sandbox_grants').get()).toEqual({ n: 3 })
  db.close()
})

it('takes an MCP server, with its name, and other agents, and nothing malformed', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS)

  const server = {
    kind: SandboxGrantKind.McpServer,
    server: 'claude_ai_Acme_Docs',
    name: 'claude.ai Acme Docs',
  } as const
  const cloud = { kind: SandboxGrantKind.Agents, agents: OtherAgents.Cloud } as const
  addSandboxGrant(db, { target: GLADE, grant: server }, 1)
  addSandboxGrant(db, { target: GLADE, grant: cloud }, 2)
  expect(listSandboxGrants(db, GLADE).map(({ grant }) => grant)).toEqual([server, cloud])

  const insert = db.prepare(
    `INSERT INTO sandbox_grants (scope, kind, value, access, name, created_at) VALUES ('glade', ?, ?, ?, ?, 3)`,
  )
  // A server has a name, and nothing else does; neither has an access; agents are one of the two.
  expect(() => insert.run('mcp_server', 'gmail', null, null)).toThrow(/CHECK/)
  expect(() => insert.run('mcp_server', 'gmail', null, '')).toThrow(/CHECK/)
  expect(() => insert.run('mcp_server', 'gmail', 'read', 'Gmail')).toThrow(/CHECK/)
  expect(() => insert.run('domain', 'acme.dev', null, 'Acme')).toThrow(/CHECK/)
  expect(() => insert.run('agents', 'sessions', null, 'Sessions')).toThrow(/CHECK/)
  expect(() => insert.run('agents', 'everyone', null, null)).toThrow(/CHECK/)
  expect(() => insert.run('agents', 'sessions', 'read', null)).toThrow(/CHECK/)
  expect(() => insert.run('socket', '/var/run/docker.sock', null, null)).toThrow(/CHECK/)
  // Only a folder's row can be a single file's, as before.
  expect(() => db.prepare(`UPDATE sandbox_grants SET is_file = 1 WHERE kind = 'mcp_server'`).run()).toThrow(/CHECK/)
  db.close()
})

it('keeps the servers a workspace’s sessions report, which go with the workspace', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS)
  const { id } = createWorkspace(db, { name: 'Acme API', rootPath: '/code/acme-api' }, 1)

  noteReportedServers(db, id, [{ server: 'acme-tracker', name: 'acme-tracker' }], 1)
  expect(listReportedServers(db, id)).toEqual([{ server: 'acme-tracker', name: 'acme-tracker' }])
  expect(() => noteReportedServers(db, 'nowhere', [{ server: 'gmail', name: 'gmail' }], 1)).toThrow(/FOREIGN KEY/)
  expect(() => noteReportedServers(db, id, [{ server: '', name: 'gmail' }], 1)).toThrow(/CHECK/)
  expect(() => noteReportedServers(db, id, [{ server: 'gmail', name: '' }], 1)).toThrow(/CHECK/)

  deleteWorkspace(db, id)
  expect(listReportedServers(db, null)).toEqual([])
  db.close()
})
