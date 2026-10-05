// Sandbox grants live only in Glade's database and the session's flag settings (#449): nothing of them goes into a
// session's start options, and nothing is written under the workspace, its `.claude/`, or `~/.claude`.
//
// These run the grants through the real runner and the real SDK adapter, down to the SDK's `query()`, which is
// replaced. So they hold Glade's own code to it: the service, the runner and the adapter hand the SDK the grants only
// as `applyFlagSettings` calls, and write no file while they do. What Claude Code then does with flag settings is its
// own business, which no unit test reaches: `docs/sdk-notes.md` §15 has the probes (a flag-settings layer kept in the
// process, taken back by the next call).
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Task, Workspace } from '../../shared/domain'
import { FolderAccess, SandboxGrantKind, SandboxGrantScope, type SandboxGrantTarget } from '../../shared/sandbox'
import { settle } from '../agent/fake-backend'
import { createAgentRunner, type AgentRunner } from '../agent/runner'
import { sandboxOverlay, sandboxStartSettings } from '../agent/sandbox'
import { createSdkBackend, sdkFlagSettings } from '../agent/sdk-backend'
import { updateSettings } from '../db/repositories/settings'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import {
  changeSandboxFolderAccess,
  grantSandboxAccess,
  revokeSandboxGrant,
  sandboxGrantsOf,
  taskSandboxGrants,
  type SandboxGrantsContext,
} from './grants'

const sdk = vi.hoisted(() => {
  /** A session that says it has started, then stays open, as a live one does. */
  const session = {
    applyFlagSettings: vi.fn<(settings: unknown) => Promise<void>>(() => Promise.resolve(undefined)),
    close: vi.fn(),
    [Symbol.asyncIterator]: async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'session-1', model: 'claude-sample-1' }
      await new Promise<never>(() => undefined)
    },
  }
  return {
    session,
    query: vi.fn<(params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => typeof session>(
      () => session,
    ),
  }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: sdk.query,
}))

let scratch: string
let home: string
let root: string
let notes: string
let database: TestDatabase
let workspace: Workspace
let task: Task
let runner: AgentRunner
let grants: SandboxGrantsContext
let taskTarget: SandboxGrantTarget
let workspaceTarget: SandboxGrantTarget

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

/** Starts the app's runner on the database, over the SDK adapter, as a launch does. */
function launch(): void {
  runner = createAgentRunner({
    db: database.db,
    emit: () => undefined,
    backend: createSdkBackend({ version: '1.2.3', env: Promise.resolve({}) }),
    sandboxGrants: (task) => taskSandboxGrants(database.db, task),
  })
  grants = { db: database.db, runner, emit: () => undefined }
}

/** The options the SDK's `query()` was last started with. */
function startOptions(): Record<string, unknown> {
  const options = sdk.query.mock.lastCall?.[0].options
  if (options === undefined) throw new Error('No session has started')
  return options
}

beforeEach(() => {
  vi.clearAllMocks()
  // A home folder with Claude Code's own settings in it, and a workspace inside it with its own.
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'glade-grants-')))
  home = join(scratch, 'home')
  root = join(home, 'code', 'acme-api')
  notes = join(home, 'notes')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), '{"permissions":{"allow":[]}}\n')
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude', 'settings.local.json'), '{}\n')
  writeFileSync(join(root, 'README.md'), '# Acme API\n')
  mkdirSync(notes)
  vi.stubEnv('HOME', home)
  database = openTestDatabase()
  updateSettings(database.db, { sandboxEnabled: true })
  workspace = sampleWorkspace(database.db, root)
  task = sampleTask(database.db, workspace.id)
  taskTarget = { scope: SandboxGrantScope.Task, taskId: task.id }
  workspaceTarget = { scope: SandboxGrantScope.Workspace, workspaceId: workspace.id }
  launch()
})

afterEach(() => {
  runner.close()
  database.close()
  vi.unstubAllEnvs()
  rmSync(scratch, { recursive: true, force: true })
})

/** Grants at every scope, with a session running, then changes and removes some, and relaunches. */
async function grantChangeAndRelaunch(): Promise<void> {
  runner.send(task.id, 'Read my notes.')
  await settle()
  await grantSandboxAccess(grants, {
    target: taskTarget,
    grant: { kind: SandboxGrantKind.Folder, path: notes, access: FolderAccess.ReadWrite },
  })
  await grantSandboxAccess(grants, {
    target: workspaceTarget,
    grant: { kind: SandboxGrantKind.Domain, domain: 'registry.npmjs.org' },
  })
  await grantSandboxAccess(grants, {
    target: { scope: SandboxGrantScope.Glade },
    grant: { kind: SandboxGrantKind.Folder, path: join(home, '.claude'), access: FolderAccess.Read },
  })
  await changeSandboxFolderAccess(grants, taskTarget, notes, FolderAccess.Read)
  await revokeSandboxGrant(grants, workspaceTarget, { kind: SandboxGrantKind.Domain, domain: 'registry.npmjs.org' })
  runner.close()
  launch()
  runner.send(task.id, 'Carry on.')
  await settle()
}

it('reads the stubbed home folder, so a write to ~/.claude would land in the snapshot', () => {
  expect(homedir()).toBe(home)
})

it('hands the SDK the grants as flag settings only: never in a session’s start options', async () => {
  await grantChangeAndRelaunch()

  // Two sessions: the first, and the one after the relaunch, which resumes it with two grants saved.
  expect(sdk.query).toHaveBeenCalledTimes(2)
  const start = sdkFlagSettings(sandboxStartSettings(root, home))
  for (const [{ options }] of sdk.query.mock.calls) {
    // Only the sandbox's fixed parts, whatever is granted by then.
    expect(options.sandbox).toEqual(start.sandbox)
    expect(options.settings).toMatchObject({ permissions: start.permissions })
    expect(options).not.toHaveProperty('additionalDirectories')
    expect(JSON.stringify([options.sandbox, options.allowedTools, options.settings, options.extraArgs])).not.toMatch(
      /notes|registry\.npmjs\.org|WebFetch\(domain/,
    )
  }
  expect(startOptions()).toMatchObject({ cwd: root, resume: 'session-1' })
  // Every change reached the SDK as one whole overlay, and the resumed session got what's saved, before its message.
  const applied = sdk.session.applyFlagSettings.mock.calls.map(([settings]) => settings)
  expect(applied).toHaveLength(7)
  expect(applied.at(-1)).toEqual(
    sdkFlagSettings(
      sandboxOverlay(
        root,
        task.permissionMode,
        sandboxGrantsOf([
          { kind: SandboxGrantKind.Folder, path: notes, access: FolderAccess.Read },
          { kind: SandboxGrantKind.Folder, path: join(home, '.claude'), access: FolderAccess.Read },
        ]),
        home,
      ),
    ),
  )
})

it('writes nothing under the workspace, its .claude folder, or ~/.claude', async () => {
  const before = snapshot(home)

  await grantChangeAndRelaunch()

  expect(sdk.session.applyFlagSettings).toHaveBeenCalledTimes(7)
  expect(snapshot(home)).toEqual(before)
})
