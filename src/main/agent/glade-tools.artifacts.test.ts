/**
 * The Glade tools that keep a task's artifacts current once declared (#385): `update_artifact` renames one or points it
 * at another file, `remove_artifact` takes one off the list. `add_artifact` has its own tests in `glade-tools.test.ts`.
 */
import { fileArtifacts } from '../../shared/artifacts'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventType, type GladeEvent } from '../../shared/bridge'
import { addArtifact, listArtifacts, listFileArtifacts } from '../db/repositories/artifacts'
import {
  openTestDatabase,
  sampleTask,
  sampleTodo,
  sampleWorkspace,
  type TestDatabase,
} from '../db/repositories/test-database'
import { createQuestionBroker } from '../questions/questions'
import {
  createGladeMcpServer,
  createGladeToolHandlers,
  GLADE_SERVER,
  NEW_TARGET_OF_ANOTHER_KIND,
  PATH_OR_URL,
  UPDATE_CHANGES_NOTHING,
  type GladeToolContext,
} from './glade-tools'
import { createMcpToolCaller, type McpToolCaller, type McpToolOutcome } from './mcp-tool-caller'
import { ArtifactKind } from '../../shared/domain'

let database: TestDatabase
let events: GladeEvent[]
let context: GladeToolContext
let root: string
let outside: string
let tools: McpToolCaller
let taskId: string

beforeEach(async () => {
  database = openTestDatabase()
  events = []
  const base = { db: database.db, emit: (event: GladeEvent) => events.push(event) }
  context = { ...base, questions: createQuestionBroker(base) }
  root = mkdtempSync(join(tmpdir(), 'glade-change-artifact-'))
  outside = mkdtempSync(join(tmpdir(), 'glade-change-artifact-outside-'))
  mkdirSync(join(root, 'docs', 'releases'), { recursive: true })
  mkdirSync(join(root, 'out', 'screens'), { recursive: true })
  writeFileSync(join(root, 'docs', 'releases', '2.4.md'), '# Release notes 2.4\n')
  writeFileSync(join(root, 'docs', 'releases', '2.4-upgrade.md'), '# Upgrading to 2.4\n')
  writeFileSync(join(root, 'out', 'screens', 'landing.png'), 'png')
  writeFileSync(join(outside, 'secret.md'), 'not yours\n')
  symlinkSync(join(outside, 'secret.md'), join(root, 'docs', 'linked.md'))
  taskId = sampleTask(database.db, sampleWorkspace(database.db, root).id).id
  sampleTodo(database.db, taskId)
  tools = createMcpToolCaller({ [GLADE_SERVER]: createGladeMcpServer(context, taskId) })
  vi.useFakeTimers({ now: 1_000, toFake: ['Date'] })
  await tools.call('mcp__glade__add_artifact', { path: 'docs/releases/2.4.md', title: 'Release notes', todo: '1' })
  vi.setSystemTime(1_100)
  await tools.call('mcp__glade__add_artifact', { path: 'out/screens/landing.png', title: 'Landing page', todo: '1' })
  vi.setSystemTime(2_000)
  events.length = 0
})

afterEach(async () => {
  vi.useRealTimers()
  await tools.close()
  database.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

/** The task's artifacts, as `[path, title]`, in their order. */
function listed(): string[][] {
  return listFileArtifacts(database.db, taskId).map(({ path, title }) => [path, title])
}

/** Each `artifacts.changed` for the task, as its list of `path: title`. */
function changes(): (readonly string[])[] {
  return events.flatMap((event) =>
    event.type === EventType.ArtifactsChanged && event.taskId === taskId
      ? [fileArtifacts(event.artifacts).map(({ path, title }) => `${path}: ${title}`)]
      : [],
  )
}

function update(input: Record<string, unknown>): Promise<McpToolOutcome> {
  return tools.call('mcp__glade__update_artifact', input)
}

function remove(input: Record<string, unknown>): Promise<McpToolOutcome> {
  return tools.call('mcp__glade__remove_artifact', input)
}

describe('update_artifact', () => {
  it('renames an artifact, by a relative or absolute path, keeping its place and file, and broadcasts the list', async () => {
    await expect(update({ path: 'docs/releases/2.4.md', title: 'Release notes 2.4' })).resolves.toEqual({
      output: 'Renamed the artifact docs/releases/2.4.md to "Release notes 2.4".',
      isError: false,
    })
    await expect(
      update({ path: join(root, 'out', 'screens', 'landing.png'), title: 'Landing page, dark' }),
    ).resolves.toMatchObject({ output: 'Renamed the artifact out/screens/landing.png to "Landing page, dark".' })

    expect(listed()).toEqual([
      ['docs/releases/2.4.md', 'Release notes 2.4'],
      ['out/screens/landing.png', 'Landing page, dark'],
    ])
    expect(listFileArtifacts(database.db, taskId)[0]).toMatchObject({
      addedAt: 1_000,
      updatedAt: 2_000,
      missing: false,
    })
    expect(changes()).toEqual([
      ['docs/releases/2.4.md: Release notes 2.4', 'out/screens/landing.png: Landing page'],
      ['docs/releases/2.4.md: Release notes 2.4', 'out/screens/landing.png: Landing page, dark'],
    ])
  })

  it('points an artifact at its file where it moved, keeping its title and place, and looks at the new file', async () => {
    renameSync(join(root, 'docs', 'releases', '2.4.md'), join(root, 'docs', 'releases', 'notes-2.4.md'))
    const moved = new Date('2026-09-20T10:00:00Z')
    utimesSync(join(root, 'docs', 'releases', 'notes-2.4.md'), moved, moved)

    await expect(update({ path: 'docs/releases/2.4.md', newPath: 'docs/releases/notes-2.4.md' })).resolves.toEqual({
      output: 'Moved the artifact "Release notes" from docs/releases/2.4.md to docs/releases/notes-2.4.md.',
      isError: false,
    })

    expect(listFileArtifacts(database.db, taskId)[0]).toEqual({
      kind: ArtifactKind.File,
      taskId,
      path: 'docs/releases/notes-2.4.md',
      title: 'Release notes',
      addedAt: 1_000,
      updatedAt: 2_000,
      modifiedAt: moved.getTime(),
      missing: false,
    })
    expect(changes()).toEqual([['docs/releases/notes-2.4.md: Release notes', 'out/screens/landing.png: Landing page']])
  })

  it('repoints an artifact whose file is gone, and renames it in the same call', async () => {
    rmSync(join(root, 'out', 'screens', 'landing.png'))
    writeFileSync(join(root, 'out', 'screens', 'landing-v2.png'), 'png')

    await expect(
      update({ path: 'out/screens/landing.png', newPath: 'out/screens/landing-v2.png', title: 'Landing page v2' }),
    ).resolves.toEqual({
      output: 'Moved the artifact out/screens/landing.png to out/screens/landing-v2.png, now called "Landing page v2".',
      isError: false,
    })
    expect(listFileArtifacts(database.db, taskId)[1]).toMatchObject({
      path: 'out/screens/landing-v2.png',
      title: 'Landing page v2',
      addedAt: 1_100,
      missing: false,
    })
  })

  it('takes a newPath to the same file as a rename, and a change to nothing as nothing', async () => {
    await expect(
      update({ path: 'docs/releases/2.4.md', newPath: './docs/releases/2.4.md', title: 'Notes' }),
    ).resolves.toMatchObject({ output: 'Renamed the artifact docs/releases/2.4.md to "Notes".' })
    vi.setSystemTime(3_000)
    events.length = 0

    await expect(
      update({ path: 'docs/releases/2.4.md', newPath: join(root, 'docs', 'releases', '2.4.md'), title: 'Notes' }),
    ).resolves.toEqual({
      output: 'The artifact docs/releases/2.4.md is already called "Notes"; nothing changed.',
      isError: false,
    })
    expect(listFileArtifacts(database.db, taskId)[0]).toMatchObject({ title: 'Notes', updatedAt: 2_000 })
    expect(events).toEqual([])
  })

  it('answers with a tool error, changing nothing, for anything it can’t do', async () => {
    const refused = async (input: Record<string, unknown>, output?: string): Promise<void> => {
      const result = await update(input)
      expect(result.isError, JSON.stringify(input)).toBe(true)
      if (output !== undefined) expect(result.output).toBe(output)
    }
    await refused({ path: 'docs/releases/2.4.md' }, UPDATE_CHANGES_NOTHING)
    await refused(
      { path: 'docs/releases/2.4-upgrade.md', title: 'Upgrade guide' },
      "docs/releases/2.4-upgrade.md isn't one of this task's artifacts.",
    )
    await refused({ path: '/etc/hosts', title: 'Hosts' }, `/etc/hosts is outside the workspace (${root}).`)
    await refused({ path: '../secrets.md', title: 'Secrets' })
    await refused({ path: 'docs/releases/2.4.md', newPath: 'docs/gone.md' }, "There's no file at docs/gone.md.")
    await refused({ path: 'docs/releases/2.4.md', newPath: 'docs' }, "There's no file at docs.")
    await refused({ path: 'docs/releases/2.4.md', newPath: join(outside, 'secret.md') })
    // A symlink inside the workspace to a file outside it.
    await refused({ path: 'docs/releases/2.4.md', newPath: 'docs/linked.md' })
    await refused(
      { path: 'docs/releases/2.4.md', newPath: 'out/screens/landing.png' },
      'out/screens/landing.png is already one of this task\'s artifacts ("Landing page"). Remove one of them first.',
    )
    for (const input of [
      {},
      { path: ' ', title: 'x' },
      { path: 'docs/releases/2.4.md', title: ' ' },
      { path: 'docs/releases/2.4.md', newPath: '' },
    ]) {
      await refused(input)
    }

    expect(listed()).toEqual([
      ['docs/releases/2.4.md', 'Release notes'],
      ['out/screens/landing.png', 'Landing page'],
    ])
    expect(changes()).toEqual([])
  })

  it('fails, changing nothing, when the artifact goes or its new path is declared while the file is checked', async () => {
    writeFileSync(join(root, 'docs', 'releases', 'notes.md'), '# Notes\n')
    const handlers = createGladeToolHandlers(context, taskId)

    const moving = handlers.updateArtifact({ path: 'docs/releases/2.4.md', newPath: 'docs/releases/notes.md' })
    handlers.removeArtifact({ path: 'docs/releases/2.4.md' })
    await expect(moving).resolves.toEqual({
      content: [{ type: 'text', text: "docs/releases/2.4.md isn't one of this task's artifacts." }],
      isError: true,
    })

    const racing = handlers.updateArtifact({ path: 'out/screens/landing.png', newPath: 'docs/releases/notes.md' })
    addArtifact(database.db, { taskId, path: 'docs/releases/notes.md', title: 'Notes' })
    await expect(racing).resolves.toEqual({
      content: [
        {
          type: 'text',
          text: 'docs/releases/notes.md is already one of this task\'s artifacts ("Notes"). Remove one of them first.',
        },
      ],
      isError: true,
    })
    expect(listed()).toEqual([
      ['out/screens/landing.png', 'Landing page'],
      ['docs/releases/notes.md', 'Notes'],
    ])
  })
})

describe('remove_artifact', () => {
  it('takes an artifact off the list, by a relative or absolute path, leaving its file, and broadcasts the list', async () => {
    await expect(remove({ path: 'docs/releases/2.4.md' })).resolves.toEqual({
      output: 'Removed docs/releases/2.4.md ("Release notes") from the artifacts. The file itself is untouched.',
      isError: false,
    })
    expect(existsSync(join(root, 'docs', 'releases', '2.4.md'))).toBe(true)
    await remove({ path: join(root, 'out', 'screens', 'landing.png') })

    expect(listed()).toEqual([])
    expect(changes()).toEqual([['out/screens/landing.png: Landing page'], []])
  })

  it('removes an artifact whose file is gone', async () => {
    rmSync(join(root, 'out', 'screens', 'landing.png'))

    await expect(remove({ path: 'out/screens/landing.png' })).resolves.toMatchObject({ isError: false })
    expect(listed()).toEqual([['docs/releases/2.4.md', 'Release notes']])
  })

  it('answers with a tool error, changing nothing, for a path that isn’t one of the artifacts', async () => {
    await remove({ path: 'docs/releases/2.4.md' })
    events.length = 0

    await expect(remove({ path: 'docs/releases/2.4.md' })).resolves.toEqual({
      output: "docs/releases/2.4.md isn't one of this task's artifacts.",
      isError: true,
    })
    await expect(remove({ path: 'docs/releases/2.4-upgrade.md' })).resolves.toMatchObject({ isError: true })
    await expect(remove({ path: '/etc/hosts' })).resolves.toEqual({
      output: `/etc/hosts is outside the workspace (${root}).`,
      isError: true,
    })
    for (const input of [{}, { path: '  ' }]) expect((await remove(input)).isError).toBe(true)

    expect(listed()).toEqual([['out/screens/landing.png', 'Landing page']])
    expect(events).toEqual([])
  })
})

describe('link artifacts (#407)', () => {
  const PR = 'https://github.com/acme/api/pull/412'
  const TICKET = 'https://acme.atlassian.net/browse/API-123'

  function add(input: Record<string, unknown>): Promise<McpToolOutcome> {
    return tools.call('mcp__glade__add_artifact', { todo: '1', ...input })
  }

  /** The task's artifacts, as `kind title`, in their order. */
  function all(): string[] {
    return listArtifacts(database.db, taskId).map(({ kind, title }) => `${kind} ${title}`)
  }

  it('adds a link by its url, after the files, and renames it when it’s added again', async () => {
    await expect(add({ url: 'HTTPS://github.com/acme/api/pull/412', title: 'Navigation refresh' })).resolves.toEqual({
      output: `Added ${PR} to the artifacts as "Navigation refresh". It's under todo #1.`,
      isError: false,
    })
    vi.setSystemTime(3_000)
    await expect(add({ url: PR, title: '#412' })).resolves.toEqual({
      output: `Renamed the artifact ${PR} to "#412". It's under todo #1.`,
      isError: false,
    })

    expect(all()).toEqual(['file Release notes', 'file Landing page', 'link #412'])
    expect(events.filter(({ type }) => type === EventType.ArtifactsChanged)).toHaveLength(2)
  })

  it('renames a link, points it at another page, and takes it off, by its url', async () => {
    await add({ url: PR, title: 'PR' })

    await expect(update({ url: PR, title: 'Navigation refresh' })).resolves.toEqual({
      output: `Renamed the artifact ${PR} to "Navigation refresh".`,
      isError: false,
    })
    await expect(update({ url: PR, newUrl: TICKET })).resolves.toEqual({
      output: `Moved the artifact "Navigation refresh" from ${PR} to ${TICKET}.`,
      isError: false,
    })
    await expect(update({ url: TICKET, newUrl: PR, title: 'PR again' })).resolves.toEqual({
      output: `Moved the artifact ${TICKET} to ${PR}, now called "PR again".`,
      isError: false,
    })
    await expect(update({ url: PR, title: 'PR again' })).resolves.toEqual({
      output: `The artifact ${PR} is already called "PR again"; nothing changed.`,
      isError: false,
    })
    await expect(remove({ url: PR })).resolves.toEqual({
      output: `Removed ${PR} ("PR again") from the artifacts.`,
      isError: false,
    })

    expect(all()).toEqual(['file Release notes', 'file Landing page'])
  })

  it('answers with a tool error, changing nothing, for a url that can’t be one or isn’t one', async () => {
    await add({ url: PR, title: 'PR' })
    events.length = 0

    for (const url of ['javascript:alert(1)', 'file:///etc/hosts', 'mailto:me@example.com', 'example.com/docs']) {
      const outcome = await add({ url, title: 'Bad' })
      expect(outcome.isError, url).toBe(true)
      expect(outcome.output, url).toMatch(/^The url /)
    }
    await expect(update({ url: TICKET, title: 'X' })).resolves.toEqual({
      output: `${TICKET} isn't one of this task's artifacts.`,
      isError: true,
    })
    await expect(update({ url: PR, newUrl: 'data:text/plain,hi' })).resolves.toMatchObject({ isError: true })
    await expect(remove({ url: TICKET })).resolves.toMatchObject({ isError: true })

    expect(all()).toEqual(['file Release notes', 'file Landing page', 'link PR'])
    expect(events).toEqual([])
  })

  it('needs one of path and url, not both, and a file a newPath and a link a newUrl', async () => {
    await add({ url: PR, title: 'PR' })
    events.length = 0

    for (const outcome of [
      await add({ title: 'Nothing' }),
      await add({ path: 'docs/releases/2.4.md', url: PR, title: 'Both' }),
      await update({ title: 'Nothing' }),
      await update({ path: 'docs/releases/2.4.md', url: PR, title: 'Both' }),
      await remove({}),
      await remove({ path: 'docs/releases/2.4.md', url: PR }),
    ]) {
      expect(outcome).toEqual({ output: PATH_OR_URL, isError: true })
    }
    await expect(update({ url: PR })).resolves.toEqual({ output: UPDATE_CHANGES_NOTHING, isError: true })
    await expect(update({ url: PR, newPath: 'docs/releases/2.4.md' })).resolves.toEqual({
      output: NEW_TARGET_OF_ANOTHER_KIND,
      isError: true,
    })
    await expect(update({ path: 'docs/releases/2.4.md', newUrl: PR })).resolves.toEqual({
      output: NEW_TARGET_OF_ANOTHER_KIND,
      isError: true,
    })

    expect(all()).toEqual(['file Release notes', 'file Landing page', 'link PR'])
    expect(events).toEqual([])
  })
})
