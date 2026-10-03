import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Effort, type Task, type Workspace } from '../../../shared/domain'
import {
  FolderAccess,
  SandboxGrantKind,
  SandboxGrantScope,
  type Grant,
  type SandboxGrantTarget,
} from '../../../shared/sandbox'
import {
  addSandboxGrant,
  listGrantsCovering,
  listSandboxGrants,
  removeSandboxGrant,
  SandboxGrantChange,
  setSandboxFolderAccess,
} from './sandbox-grants'
import { createTask } from './tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'
import { createWorkspace } from './workspaces'

const read = (path: string): Grant => ({ kind: SandboxGrantKind.Folder, path, access: FolderAccess.Read })
const readWrite = (path: string): Grant => ({ kind: SandboxGrantKind.Folder, path, access: FolderAccess.ReadWrite })
const domain = (host: string): Grant => ({ kind: SandboxGrantKind.Domain, domain: host })

const GLADE: SandboxGrantTarget = { scope: SandboxGrantScope.Glade }

let database: TestDatabase
let workspace: Workspace
let task: Task
let other: Task
let elsewhere: Task
let workspaceTarget: SandboxGrantTarget
let taskTarget: SandboxGrantTarget

beforeEach(() => {
  database = openTestDatabase()
  workspace = sampleWorkspace(database.db)
  task = sampleTask(database.db, workspace.id)
  other = sampleTask(database.db, workspace.id, 3_000)
  const otherWorkspace = createWorkspace(database.db, { name: 'Acme Web', rootPath: '/code/acme-web' }, 1_000)
  elsewhere = createTask(
    database.db,
    { workspaceId: otherWorkspace.id, model: 'claude-sample-1', effort: Effort.Medium },
    4_000,
  )
  workspaceTarget = { scope: SandboxGrantScope.Workspace, workspaceId: workspace.id }
  taskTarget = { scope: SandboxGrantScope.Task, taskId: task.id }
})

afterEach(() => {
  database.close()
})

function add(target: SandboxGrantTarget, grant: Grant, now = 10): SandboxGrantChange {
  return addSandboxGrant(database.db, { target, grant }, now)
}

describe('addSandboxGrant', () => {
  it('adds folders and domains to each scope, in the order granted', () => {
    expect(add(GLADE, read('/opt/sdk'), 10)).toBe(SandboxGrantChange.Added)
    expect(add(GLADE, domain('registry.npmjs.org'), 11)).toBe(SandboxGrantChange.Added)
    expect(add(workspaceTarget, readWrite('/Users/sam/shared'), 12)).toBe(SandboxGrantChange.Added)
    expect(add(taskTarget, domain('acme.dev'), 13)).toBe(SandboxGrantChange.Added)

    expect(listSandboxGrants(database.db, GLADE)).toEqual([
      { target: GLADE, grant: read('/opt/sdk'), createdAt: 10 },
      { target: GLADE, grant: domain('registry.npmjs.org'), createdAt: 11 },
    ])
    expect(listSandboxGrants(database.db, workspaceTarget)).toEqual([
      { target: workspaceTarget, grant: readWrite('/Users/sam/shared'), createdAt: 12 },
    ])
    expect(listSandboxGrants(database.db, taskTarget)).toEqual([
      { target: taskTarget, grant: domain('acme.dev'), createdAt: 13 },
    ])
    expect(listSandboxGrants(database.db, { scope: SandboxGrantScope.Task, taskId: other.id })).toEqual([])
  })

  it('never duplicates a grant: the first stays, granted when it first was', () => {
    add(taskTarget, domain('acme.dev'), 10)
    expect(add(taskTarget, domain('acme.dev'), 20)).toBe(SandboxGrantChange.Unchanged)
    add(taskTarget, read('/opt/sdk'), 11)
    expect(add(taskTarget, read('/opt/sdk'), 21)).toBe(SandboxGrantChange.Unchanged)

    expect(listSandboxGrants(database.db, taskTarget)).toEqual([
      { target: taskTarget, grant: domain('acme.dev'), createdAt: 10 },
      { target: taskTarget, grant: read('/opt/sdk'), createdAt: 11 },
    ])
  })

  it('upgrades a read-only folder granted read-write, and never narrows a read-write one', () => {
    add(workspaceTarget, read('/Users/sam/shared'), 10)
    expect(add(workspaceTarget, readWrite('/Users/sam/shared'), 20)).toBe(SandboxGrantChange.Changed)
    expect(listSandboxGrants(database.db, workspaceTarget)).toEqual([
      { target: workspaceTarget, grant: readWrite('/Users/sam/shared'), createdAt: 10 },
    ])

    expect(add(workspaceTarget, read('/Users/sam/shared'), 30)).toBe(SandboxGrantChange.Unchanged)
    expect(listSandboxGrants(database.db, workspaceTarget)).toEqual([
      { target: workspaceTarget, grant: readWrite('/Users/sam/shared'), createdAt: 10 },
    ])
  })

  it('keeps the same folder at two scopes apart, each with its own access', () => {
    add(GLADE, readWrite('/opt/sdk'))
    add(workspaceTarget, read('/opt/sdk'))
    add(taskTarget, read('/opt/sdk'))

    expect(listSandboxGrants(database.db, GLADE).map(({ grant }) => grant)).toEqual([readWrite('/opt/sdk')])
    expect(listSandboxGrants(database.db, workspaceTarget).map(({ grant }) => grant)).toEqual([read('/opt/sdk')])
    expect(listSandboxGrants(database.db, taskTarget).map(({ grant }) => grant)).toEqual([read('/opt/sdk')])
  })

  it('refuses a grant for a task or workspace that doesn’t exist', () => {
    expect(() => add({ scope: SandboxGrantScope.Task, taskId: 'nothing' }, domain('acme.dev'))).toThrow(/FOREIGN KEY/)
    expect(() => add({ scope: SandboxGrantScope.Workspace, workspaceId: 'nothing' }, domain('acme.dev'))).toThrow(
      /FOREIGN KEY/,
    )
  })
})

describe('setSandboxFolderAccess', () => {
  it('downgrades and upgrades a folder, leaving other scopes alone', () => {
    add(workspaceTarget, readWrite('/Users/sam/shared'), 10)
    add(GLADE, readWrite('/Users/sam/shared'), 11)

    expect(setSandboxFolderAccess(database.db, workspaceTarget, '/Users/sam/shared', FolderAccess.Read)).toBe(
      SandboxGrantChange.Changed,
    )
    expect(listSandboxGrants(database.db, workspaceTarget)).toEqual([
      { target: workspaceTarget, grant: read('/Users/sam/shared'), createdAt: 10 },
    ])
    expect(listSandboxGrants(database.db, GLADE).map(({ grant }) => grant)).toEqual([readWrite('/Users/sam/shared')])

    expect(setSandboxFolderAccess(database.db, workspaceTarget, '/Users/sam/shared', FolderAccess.ReadWrite)).toBe(
      SandboxGrantChange.Changed,
    )
    expect(listSandboxGrants(database.db, workspaceTarget).map(({ grant }) => grant)).toEqual([
      readWrite('/Users/sam/shared'),
    ])
  })

  it('changes nothing for a folder the scope doesn’t have, or one already at that access', () => {
    add(taskTarget, read('/opt/sdk'))
    add(taskTarget, domain('opt'))
    expect(setSandboxFolderAccess(database.db, taskTarget, '/opt/sdk', FolderAccess.Read)).toBe(
      SandboxGrantChange.Unchanged,
    )
    expect(setSandboxFolderAccess(database.db, taskTarget, '/opt/other', FolderAccess.Read)).toBe(
      SandboxGrantChange.Unchanged,
    )
    expect(setSandboxFolderAccess(database.db, GLADE, '/opt/sdk', FolderAccess.ReadWrite)).toBe(
      SandboxGrantChange.Unchanged,
    )
    // A domain is never a folder, whatever its value.
    expect(setSandboxFolderAccess(database.db, taskTarget, 'opt', FolderAccess.ReadWrite)).toBe(
      SandboxGrantChange.Unchanged,
    )
    expect(listSandboxGrants(database.db, GLADE)).toEqual([])
  })
})

describe('removeSandboxGrant', () => {
  it('removes a folder whatever its access, or a domain, from its scope only', () => {
    add(GLADE, readWrite('/opt/sdk'))
    add(workspaceTarget, read('/opt/sdk'))
    add(workspaceTarget, domain('acme.dev'))

    expect(removeSandboxGrant(database.db, workspaceTarget, { kind: SandboxGrantKind.Folder, path: '/opt/sdk' })).toBe(
      true,
    )
    expect(removeSandboxGrant(database.db, workspaceTarget, { kind: SandboxGrantKind.Folder, path: '/opt/sdk' })).toBe(
      false,
    )
    // A domain and a folder with the same value are different grants.
    expect(removeSandboxGrant(database.db, workspaceTarget, { kind: SandboxGrantKind.Folder, path: 'acme.dev' })).toBe(
      false,
    )
    expect(removeSandboxGrant(database.db, taskTarget, domain('acme.dev'))).toBe(false)

    expect(listSandboxGrants(database.db, workspaceTarget).map(({ grant }) => grant)).toEqual([domain('acme.dev')])
    expect(listSandboxGrants(database.db, GLADE).map(({ grant }) => grant)).toEqual([readWrite('/opt/sdk')])

    expect(
      removeSandboxGrant(database.db, workspaceTarget, { kind: SandboxGrantKind.Domain, domain: 'acme.dev' }),
    ).toBe(true)
    expect(listSandboxGrants(database.db, workspaceTarget)).toEqual([])
  })
})

describe('listGrantsCovering', () => {
  it('is empty with nothing granted', () => {
    expect(listGrantsCovering(database.db, task)).toEqual([])
  })

  it('unites the Glade-wide, workspace and task grants, and no one else’s', () => {
    add(GLADE, read('/opt/sdk'), 10)
    add(workspaceTarget, domain('registry.npmjs.org'), 11)
    add(taskTarget, readWrite('/Users/sam/notes'), 12)
    add({ scope: SandboxGrantScope.Task, taskId: other.id }, domain('other.dev'), 13)
    add({ scope: SandboxGrantScope.Workspace, workspaceId: elsewhere.workspaceId }, domain('web.dev'), 14)
    add({ scope: SandboxGrantScope.Task, taskId: elsewhere.id }, read('/Users/sam/web'), 15)

    expect(listGrantsCovering(database.db, task)).toEqual([
      read('/opt/sdk'),
      domain('registry.npmjs.org'),
      readWrite('/Users/sam/notes'),
    ])
    expect(listGrantsCovering(database.db, other)).toEqual([
      read('/opt/sdk'),
      domain('registry.npmjs.org'),
      domain('other.dev'),
    ])
    expect(listGrantsCovering(database.db, elsewhere)).toEqual([
      read('/opt/sdk'),
      domain('web.dev'),
      read('/Users/sam/web'),
    ])
  })

  it('gives a folder granted at two scopes the widest access, either way round', () => {
    add(GLADE, read('/opt/a'), 10)
    add(taskTarget, readWrite('/opt/a'), 11)
    add(workspaceTarget, readWrite('/opt/b'), 12)
    add(taskTarget, read('/opt/b'), 13)
    add(GLADE, domain('acme.dev'), 14)
    add(workspaceTarget, domain('acme.dev'), 15)

    expect(listGrantsCovering(database.db, task)).toEqual([
      readWrite('/opt/a'),
      readWrite('/opt/b'),
      domain('acme.dev'),
    ])
    // The other task in the workspace has only the wider of the shared ones.
    expect(listGrantsCovering(database.db, other)).toEqual([read('/opt/a'), readWrite('/opt/b'), domain('acme.dev')])
  })

  it('handles many grants across the scopes', () => {
    for (let index = 0; index < 200; index += 1) {
      add(GLADE, read(`/opt/tool-${String(index)}`), index)
      add(workspaceTarget, readWrite(`/opt/tool-${String(index)}`), 1_000 + index)
      add(taskTarget, domain(`host-${String(index)}.acme.dev`), 2_000 + index)
    }

    const grants = listGrantsCovering(database.db, task)
    expect(grants).toHaveLength(400)
    expect(
      grants
        .slice(0, 200)
        .every((grant) => grant.kind === SandboxGrantKind.Folder && grant.access === FolderAccess.ReadWrite),
    ).toBe(true)
    expect(grants.at(-1)).toEqual(domain('host-199.acme.dev'))
  })
})
