// Sandbox grants live only in Glade's database and the session's options (#449): granting, changing and removing them,
// with sessions running and across a relaunch, writes nothing under the workspace, its `.claude/`, or `~/.claude`.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FolderAccess, SandboxGrantKind, SandboxGrantScope } from '../../shared/sandbox'
import { FakeAgentBackend, settle } from '../agent/fake-backend'
import { createAgentRunner, type AgentRunner } from '../agent/runner'
import * as sdk from '../agent/test-sdk-messages'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { changeSandboxFolderAccess, grantSandboxAccess, revokeSandboxGrant } from './grants'
import { testSandboxOverlay } from './test-overlay'

let scratch: string
let home: string
let root: string
let database: TestDatabase
let runner: AgentRunner
let backend: FakeAgentBackend

/** Every file and folder under `dir`, with each file's content and modification time. */
function snapshot(dir: string): Record<string, string> {
  const found: Record<string, string> = {}
  for (const entry of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    const path = join(dir, entry)
    const stats = statSync(path)
    found[entry] = stats.isDirectory() ? 'folder' : `${readFileSync(path, 'utf8')} @ ${String(stats.mtimeMs)}`
  }
  return found
}

function launch(): void {
  backend = new FakeAgentBackend()
  runner = createAgentRunner({ db: database.db, emit: () => undefined, backend, sandboxOverlay: testSandboxOverlay })
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'glade-grants-'))
  home = join(scratch, 'home')
  root = join(home, 'code', 'acme-api')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), '{"permissions":{"allow":[]}}\n')
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude', 'settings.local.json'), '{}\n')
  writeFileSync(join(root, 'README.md'), '# Acme API\n')
  vi.stubEnv('HOME', home)
  database = openTestDatabase()
  launch()
})

afterEach(() => {
  runner.close()
  database.close()
  vi.unstubAllEnvs()
  rmSync(scratch, { recursive: true, force: true })
})

it('writes nothing under the workspace, its .claude folder, or ~/.claude', async () => {
  const workspace = sampleWorkspace(database.db, root)
  const task = sampleTask(database.db, workspace.id)
  const before = snapshot(home)
  const notes = join(home, 'notes')
  const taskTarget = { scope: SandboxGrantScope.Task, taskId: task.id } as const
  const workspaceTarget = { scope: SandboxGrantScope.Workspace, workspaceId: workspace.id } as const

  runner.send(task.id, 'Read my notes.')
  backend.session.emit(sdk.init())
  await settle()
  const context = { db: database.db, runner }
  await grantSandboxAccess(context, {
    target: taskTarget,
    grant: { kind: SandboxGrantKind.Folder, path: notes, access: FolderAccess.ReadWrite },
  })
  await grantSandboxAccess(context, {
    target: workspaceTarget,
    grant: { kind: SandboxGrantKind.Domain, domain: 'registry.npmjs.org' },
  })
  await grantSandboxAccess(context, {
    target: { scope: SandboxGrantScope.Glade },
    grant: { kind: SandboxGrantKind.Folder, path: join(home, '.claude'), access: FolderAccess.Read },
  })
  await changeSandboxFolderAccess(context, taskTarget, notes, FolderAccess.Read)
  await revokeSandboxGrant(context, workspaceTarget, { kind: SandboxGrantKind.Domain, domain: 'registry.npmjs.org' })
  backend.session.emit(sdk.result('Done.'))
  await settle()
  runner.close()
  launch()
  runner.send(task.id, 'Carry on.')
  await settle()

  expect(backend.session.flagSettings).toHaveLength(1)
  expect(JSON.stringify(backend.session.flagSettings)).toContain(notes)
  expect(snapshot(home)).toEqual(before)
})
