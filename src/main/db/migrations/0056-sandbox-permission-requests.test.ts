import { expect, it } from 'vitest'
import { PermissionRequestState } from '../../../shared/domain'
import { FolderAccess, SandboxAskKind, SandboxGrantScope } from '../../../shared/sandbox'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import {
  appendPermissionRequest,
  closePermissionRequest,
  getPermissionRequest,
} from '../repositories/permission-requests'
import { sampleTask, sampleWorkspace } from '../repositories/test-database'
import { MIGRATIONS } from '.'
import { sandboxPermissionRequestsMigration } from './0056-sandbox-permission-requests'

it('is migration 56, after every earlier one', () => {
  expect(sandboxPermissionRequestsMigration.version).toBe(56)
  expect(MIGRATIONS.indexOf(sandboxPermissionRequestsMigration)).toBe(MIGRATIONS.filter((m) => m.version < 56).length)
})

it('leaves existing requests asking nothing of the sandbox, granted to nobody, and checks both columns', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 56),
  )
  const task = sampleTask(db, sampleWorkspace(db).id)
  db.prepare(
    `INSERT INTO permission_requests (id, task_id, turn, tool_use_id, tool_name, input, suggestions, default_to_no,
      suppress_always_allow_rule, state, created_at, closed_at)
    VALUES ('r', ?, 1, 'toolu_1', 'Bash', '{"command":"npm test"}', '[]', 0, 0, 'open', 2, NULL)`,
  ).run(task.id)

  migrate(db, MIGRATIONS)

  expect(getPermissionRequest(db, 'r')).toMatchObject({
    state: PermissionRequestState.Open,
    sandbox: null,
    grantedScope: null,
  })
  const sandbox = db.prepare("UPDATE permission_requests SET sandbox = ? WHERE id = 'r'")
  expect(() => sandbox.run('[]')).toThrow(/CHECK/)
  expect(() => sandbox.run('not json')).toThrow(/CHECK/)
  const scope = db.prepare("UPDATE permission_requests SET granted_scope = ? WHERE id = 'r'")
  expect(() => scope.run('glade')).toThrow(/CHECK/)
  for (const value of ['task', 'workspace', null]) scope.run(value)

  // A new request keeps what it asks for, and who it was granted to.
  const ask = { kind: SandboxAskKind.Folder, path: '/Users/me/code/acme-web', access: FolderAccess.Read } as const
  const request = appendPermissionRequest(db, {
    taskId: task.id,
    turn: 1,
    toolUseId: 'toolu_2',
    agentId: null,
    toolName: 'Read',
    input: { file_path: '/Users/me/code/acme-web/package.json' },
    title: null,
    displayName: null,
    description: null,
    suggestions: [],
    defaultToNo: false,
    suppressAlwaysAllowRule: true,
    sandbox: ask,
  })
  const closed = closePermissionRequest(db, request.id, {
    state: PermissionRequestState.Allowed,
    grantedScope: SandboxGrantScope.Workspace,
  })
  expect(closed).toMatchObject({ sandbox: ask, grantedScope: SandboxGrantScope.Workspace, grantedRule: null })
  db.close()
})
