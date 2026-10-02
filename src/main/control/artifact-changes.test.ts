// Changing and taking off a task's artifacts through the control API (#385): `update_task`'s `patch.updateArtifacts`
// and `patch.removeArtifacts`, the control API's side of the agent's `update_artifact` and `remove_artifact`, through a
// real MCP client against the app's bridge on a real database and a real workspace folder.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventType } from '../../shared/bridge'
import { ArtifactKind, type Task, type Workspace } from '../../shared/domain'
import { listFileArtifacts } from '../db/repositories/artifacts'
import { getTask } from '../db/repositories/tasks'
import { createWorkspace } from '../db/repositories/workspaces'
import { checkArtifactUpdates } from './backfill'
import { ControlErrorCode } from './errors'
import { ControlToolName } from './names'
import {
  connect,
  errorCode,
  errorMessage,
  HTTP,
  startControlApp,
  type ControlApp,
  type ControlClient,
  type ToolReply,
} from './test-control'

let app: ControlApp
let client: ControlClient
let root: string
let outside: string
let workspace: Workspace
let id: string

/** Writes a file into the workspace folder, making its folders; answers with its absolute path. */
function file(path: string, content = '# Notes\n'): string {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
  return full
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'glade-artifact-changes-')))
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'glade-artifact-changes-outside-')))
  app = startControlApp()
  workspace = createWorkspace(app.database.db, { name: 'Acme API', rootPath: root })
  client = await connect(app.bridge.control.server(HTTP))
  const created = await client.call(ControlToolName.CreateTask, {
    workspaceId: workspace.id,
    title: 'Refresh the docs site',
    artifacts: [
      { path: file('notes/plan.md'), title: 'Plan' },
      { path: file('screens/landing.png', 'png'), title: 'Landing page' },
      { path: file('notes/draft.md'), title: 'Draft' },
    ],
  })
  id = taskOf(created).id
})

afterEach(async () => {
  await client.close()
  await app.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

function current(): Task {
  const found = getTask(app.database.db, id)
  if (found === undefined) throw new Error(`No task ${id}`)
  return found
}

/** The task a reply carries. */
function taskOf(reply: ToolReply): Readonly<Record<string, unknown>> & { readonly id: string } {
  const task = reply.json.task
  if (typeof task !== 'object' || task === null || !('id' in task) || typeof task.id !== 'string') {
    throw new Error(`No task in ${reply.text}`)
  }
  return { ...task, id: task.id }
}

/** The task's artifacts, as `[path relative to the root, title]`, in their order. */
function listed(): string[][] {
  return listFileArtifacts(app.database.db, id).map(({ path, title }) => [path, title])
}

function patch(changes: Readonly<Record<string, unknown>>): Promise<ToolReply> {
  return client.call(ControlToolName.UpdateTask, { id, patch: changes })
}

describe('update_task: updateArtifacts and removeArtifacts', () => {
  it('renames, repoints and takes off artifacts, keeping their places and the task’s, in one broadcast', async () => {
    renameSync(join(root, 'screens', 'landing.png'), join(root, 'screens', 'landing-dark.png'))
    const moved = new Date('2026-09-20T10:00:00Z')
    utimesSync(join(root, 'screens', 'landing-dark.png'), moved, moved)
    const before = current()
    const events = app.events.length

    const reply = await patch({
      updateArtifacts: [
        { path: join(root, 'notes', 'plan.md'), title: 'Plan, final' },
        { path: join(root, 'screens', 'landing.png'), newPath: join(root, 'screens', 'landing-dark.png') },
      ],
      removeArtifacts: [join(root, 'notes', 'draft.md')],
    })

    expect(reply.isError).toBe(false)
    expect(taskOf(reply).artifacts).toEqual([
      {
        kind: ArtifactKind.File,
        path: join(root, 'notes', 'plan.md'),
        title: 'Plan, final',
        addedAt: expect.any(Number) as unknown,
      },
      {
        kind: ArtifactKind.File,
        path: join(root, 'screens', 'landing-dark.png'),
        title: 'Landing page',
        addedAt: expect.any(Number) as unknown,
      },
    ])
    expect(listFileArtifacts(app.database.db, id)[1]).toMatchObject({ modifiedAt: moved.getTime(), missing: false })
    // The draft's file stays.
    expect(realpathSync(join(root, 'notes', 'draft.md'))).toBe(join(root, 'notes', 'draft.md'))
    expect(app.events.slice(events)).toEqual([
      { type: EventType.ArtifactsChanged, taskId: id, artifacts: listFileArtifacts(app.database.db, id) },
    ])
    // Only artifacts changed: the task keeps its place in the sidebar.
    expect(current()).toEqual(before)
  })

  it('takes off, then changes, then adds, each against the list the ones before leave', async () => {
    file('notes/plan-v2.md')

    const reply = await patch({
      removeArtifacts: [join(root, 'notes', 'plan.md')],
      // The plan's path is free once it's off, so the draft can take it; then the new draft is added.
      updateArtifacts: [
        { path: join(root, 'notes', 'draft.md'), newPath: join(root, 'notes', 'plan.md'), title: 'Plan' },
        { path: join(root, 'notes', 'plan.md'), newPath: join(root, 'notes', 'plan-v2.md') },
      ],
      artifacts: [{ path: join(root, 'notes', 'draft.md'), title: 'New draft' }],
    })

    expect(reply.isError).toBe(false)
    expect(listed()).toEqual([
      ['screens/landing.png', 'Landing page'],
      ['notes/plan-v2.md', 'Plan'],
      ['notes/draft.md', 'New draft'],
    ])
  })

  it('renames one whose newPath is its own file, and takes off one whose file is gone', async () => {
    rmSync(join(root, 'notes', 'draft.md'))

    await patch({
      updateArtifacts: [{ path: join(root, 'notes', 'plan.md'), newPath: join(root, 'notes', 'plan.md'), title: 'P' }],
      removeArtifacts: [join(root, 'notes', 'draft.md')],
    })

    expect(listed()).toEqual([
      ['notes/plan.md', 'P'],
      ['screens/landing.png', 'Landing page'],
    ])
  })

  it('changes the task too, in the same patch', async () => {
    const reply = await patch({ title: 'Refresh the docs', removeArtifacts: [join(root, 'notes', 'draft.md')] })

    expect(taskOf(reply)).toMatchObject({ title: 'Refresh the docs' })
    expect(listed()).toHaveLength(2)
  })

  it('refuses, changing nothing, what it can’t do, naming the field and why', async () => {
    symlinkSync(join(outside, 'secret.md'), join(root, 'notes', 'linked.md'))
    writeFileSync(join(outside, 'secret.md'), 'not yours\n')
    const plan = join(root, 'notes', 'plan.md')
    const cases: [Readonly<Record<string, unknown>>, string][] = [
      [
        { updateArtifacts: [{ path: join(root, 'notes', 'other.md'), title: 'Other' }] },
        `patch.updateArtifacts.0.path: ${join(root, 'notes', 'other.md')} isn't one of the task's artifacts`,
      ],
      [
        { removeArtifacts: [plan, join(root, 'gone.md')] },
        "patch.removeArtifacts.1: gone.md isn't one of the task's artifacts",
      ],
      [{ removeArtifacts: [plan, plan] }, "patch.removeArtifacts.1: notes/plan.md isn't one of the task's artifacts"],
      [
        { removeArtifacts: [plan], updateArtifacts: [{ path: plan, title: 'Plan' }] },
        `patch.updateArtifacts.0.path: ${plan} isn't one of the task's artifacts`,
      ],
      [
        { updateArtifacts: [{ path: plan, newPath: join(root, 'screens', 'landing.png') }] },
        `patch.updateArtifacts.0.newPath: ${join(root, 'screens', 'landing.png')} is already one of the task's artifacts`,
      ],
      [
        { updateArtifacts: [{ path: plan, newPath: join(root, 'gone.md') }] },
        `patch.updateArtifacts.0.newPath: There's no file at ${join(root, 'gone.md')}.`,
      ],
      [
        { updateArtifacts: [{ path: plan, newPath: join(root, 'notes') }] },
        `patch.updateArtifacts.0.newPath: There's no file at ${join(root, 'notes')}.`,
      ],
      [
        { updateArtifacts: [{ path: plan, newPath: join(outside, 'secret.md') }] },
        `patch.updateArtifacts.0.newPath: ${join(outside, 'secret.md')} is outside the workspace (${root}).`,
      ],
      [
        { updateArtifacts: [{ path: join(outside, 'secret.md'), title: 'Secret' }] },
        `patch.updateArtifacts.0.path: ${join(outside, 'secret.md')} is outside the workspace (${root})`,
      ],
      [
        { removeArtifacts: [join(outside, 'secret.md')] },
        `patch.removeArtifacts.0: ${join(outside, 'secret.md')} is outside the workspace (${root})`,
      ],
      [{ updateArtifacts: [{ path: plan }] }, 'patch.updateArtifacts.0: changes nothing'],
      [{ updateArtifacts: [] }, 'patch.updateArtifacts: is empty'],
      [{ removeArtifacts: [] }, 'patch.removeArtifacts: is empty'],
      [{ removeArtifacts: ['notes/plan.md'] }, 'patch.removeArtifacts.0: must be an absolute path or a url'],
      [
        { updateArtifacts: [{ path: plan, newPath: 'notes/plan-v2.md' }] },
        'patch.updateArtifacts.0.newPath: must be an absolute path',
      ],
      [{ updateArtifacts: [{ path: plan, title: ' ' }] }, 'patch.updateArtifacts.0.title: is empty'],
      [
        { updateArtifacts: [{ path: plan, title: 'Plan', name: 'Plan' }] },
        'patch.updateArtifacts.0.name: unknown field',
      ],
    ]
    const before = current()
    const events = app.events.length

    for (const [changes, message] of cases) {
      // With a change to the task alongside, which mustn't happen either.
      const reply = await patch({ title: 'Renamed', ...changes })
      expect(errorCode(reply), message).toBe(ControlErrorCode.InvalidInput)
      expect(errorMessage(reply)).toBe(message)
    }
    // A symlink inside the workspace to a file outside it.
    const linked = await patch({ updateArtifacts: [{ path: plan, newPath: join(root, 'notes', 'linked.md') }] })
    expect(errorMessage(linked)).toMatch(/^patch\.updateArtifacts\.0\.newPath: .* is outside the workspace/)

    expect(current()).toEqual(before)
    expect(listed()).toEqual([
      ['notes/plan.md', 'Plan'],
      ['screens/landing.png', 'Landing page'],
      ['notes/draft.md', 'Draft'],
    ])
    expect(app.events.length).toBe(events)
  })
})

describe('checkArtifactUpdates', () => {
  it('names the field for a path outside the workspace the schema let through, and one that isn’t absolute', async () => {
    await expect(checkArtifactUpdates(root, [{ path: '/elsewhere/a.md', title: 'A' }], 'changes')).rejects.toThrow(
      `changes.0.path: /elsewhere/a.md is outside the workspace (${root})`,
    )
    await expect(
      checkArtifactUpdates(root, [{ path: join(root, 'a.md'), newPath: 'b.md' }], 'changes'),
    ).rejects.toThrow(/^changes\.0\.newPath: /)
  })
})
