// Programmatic control over HTTP, end to end: Settings › Control turns the endpoint on and shows the URL and the
// command with its token; a real MCP client in the spec connects over Streamable HTTP, as `claude mcp add --transport
// http` would, and drives the running app, importing an invented Claude Code session too, and the window shows each
// change. A script's plain `fetch` works too.
// Regenerating the token refuses the old one; turning the switch off stops the endpoint.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Page } from '@playwright/test'
import { REPLIES_BRIEFLY } from '../src/main/agent/scripts'
import { projectSlug, TranscriptBuilder } from '../src/main/control/claude-code/test-transcripts'
import { expect, test, type Glade } from './fixtures'
import { chooseMenuItem } from './menu'
import { chat, firstRun, settings, taskHeader, taskList } from './selectors'

const FIRST_MESSAGE = 'Draft the release notes for 2.4.'
const TITLE = 'Release notes for 2.4'
const RENAMED = 'Release notes for 2.4.0'

/** An invented Claude Code session, imported over HTTP. */
const IMPORTED_SESSION = '3c9d1e7a-6b2f-4a8e-9d10-5f4e3b2a1c0d'
const IMPORTED_PROMPT = 'Why does the /search endpoint time out under load?'
const IMPORTED_REPLY = 'It scanned the whole table; an index on the query column fixes it.'
const IMPORTED_TITLE = 'Speed up the search endpoint'

/** A tool's JSON result, from a client's call. */
interface Reply {
  readonly isError: boolean
  readonly json: Record<string, unknown>
}

/** An MCP client connected to the endpoint with a token. */
interface HttpClient {
  call(name: string, input?: Record<string, unknown>): Promise<Reply>
  close(): Promise<void>
}

async function connect(url: string, token: string): Promise<HttpClient> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name: 'glade-e2e', version: '1.0.0' })
  await client.connect(transport)
  return {
    async call(name, input = {}) {
      const result = await client.callTool({ name, arguments: input })
      return { isError: result.isError === true, json: (result.structuredContent ?? {}) as Record<string, unknown> }
    },
    close: () => client.close(),
  }
}

/** Opens Settings › Control. */
async function openControl(glade: Glade): Promise<ReturnType<typeof settings>> {
  const modal = settings(glade.window)
  await chooseMenuItem(glade, 'Glade', 'Settings…')
  await modal.section('Control').click()
  await expect(modal.heading).toHaveText('Control')
  return modal
}

/** The URL and token Settings › Control shows. */
async function shown(modal: ReturnType<typeof settings>): Promise<{ url: string; token: string }> {
  await expect(modal.connectCommand).toContainText('claude mcp add --transport http glade-control http://127.0.0.1:')
  const url = (await modal.endpoint.textContent()) ?? ''
  const command = (await modal.connectCommand.textContent()) ?? ''
  const token = /Authorization: Bearer ([A-Za-z0-9_-]+)"$/.exec(command)?.[1] ?? ''
  expect(command).toBe(`claude mcp add --transport http glade-control ${url} --header "Authorization: Bearer ${token}"`)
  expect(token).toHaveLength(43)
  return { url, token }
}

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(settings(page).dialog).toBeHidden()
}

test('an MCP client over HTTP, connected with what Settings › Control shows, creates, renames, finishes and deletes a task, and imports a Claude Code session, and the window shows each change', async ({
  launch,
  tempFolder,
}) => {
  const root = join(realpathSync(tempFolder()), 'acme-api')
  mkdirSync(root)
  // Claude Code's config folder, a temporary one holding an invented session started in the workspace's folder.
  const config = realpathSync(tempFolder('glade-e2e-claude-'))
  const projects = join(config, 'projects', projectSlug(root))
  mkdirSync(projects, { recursive: true })
  const startedAt = Date.now() - 60 * 60 * 1000
  writeFileSync(
    join(projects, `${IMPORTED_SESSION}.jsonl`),
    new TranscriptBuilder(root, startedAt)
      .prompt(0, IMPORTED_PROMPT)
      .say(8, IMPORTED_REPLY)
      .aiTitle(IMPORTED_TITLE)
      .toJsonl(),
  )
  const glade = await launch({
    agentScriptsByFirstMessage: { [FIRST_MESSAGE]: 'replies-briefly' },
    chosenFolder: root,
    env: { CLAUDE_CONFIG_DIR: config },
  })
  const { window } = glade
  await firstRun(window).openFolder.click()
  const list = taskList(window)

  // Off to begin with: the switch alone.
  const modal = await openControl(glade)
  const toggle = modal.toggle('Let agents control Glade')
  await expect(toggle).not.toBeChecked()
  await expect(modal.connectCommand).toBeHidden()

  await toggle.click()
  await expect(toggle).toBeChecked()
  const { url, token } = await shown(modal)
  await closeSettings(window)

  const client = await connect(url, token)
  const workspaces = await client.call('list_workspaces')
  const workspace = (workspaces.json.workspaces as { id: string; rootPath: string }[])[0]
  expect(workspace?.rootPath).toBe(root)

  // Created with a first message: it shows in the sidebar and its agent runs its turn.
  const created = await client.call('create_task', { workspaceId: workspace?.id, title: TITLE, message: FIRST_MESSAGE })
  expect(created.isError).toBe(false)
  const id = (created.json.task as { id: string }).id
  await expect(list.row('Active', TITLE)).toBeVisible()
  await list.row('Active', TITLE).click()
  await expect(taskHeader(window).title).toHaveText(TITLE)
  await expect(chat(window).userMessages.first()).toContainText(FIRST_MESSAGE)
  await expect(chat(window).agentReplies.last()).toContainText(REPLIES_BRIEFLY.reply)

  // A script's plain fetch sees it too.
  const listed = await fetch(`${new URL(url).origin}/v1/tools/list_tasks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId: workspace?.id }),
  })
  expect(listed.status).toBe(200)
  expect(await listed.json()).toMatchObject({ tasks: [{ id, title: TITLE }] })

  // Renamed.
  expect((await client.call('update_task', { id, patch: { title: RENAMED } })).isError).toBe(false)
  await expect(taskHeader(window).title).toHaveText(RENAMED)
  await expect(list.row('Active', RENAMED)).toBeVisible()

  // Marked done.
  expect((await client.call('mark_done', { id })).isError).toBe(false)
  await expect(taskHeader(window).stateDot).toHaveAccessibleName(/^Done/)
  await expect(list.row('Active', RENAMED)).toHaveCount(0)
  await expect(list.sectionHeader('Done')).toHaveText('Done1')

  // Deleted, which needs confirm.
  expect((await client.call('delete_task', { id })).json).toMatchObject({ error: { code: 'confirm_required' } })
  expect((await client.call('delete_task', { id, confirm: true })).json).toEqual({ deleted: id })
  await expect(list.taskRow(RENAMED)).toHaveCount(0)
  await expect(list.sectionHeader('Done')).toHaveText('Done0')
  await expect(taskHeader(window).title).toHaveCount(0)

  // A Claude Code session, listed and imported: it's under Done with its title and chat.
  const sessions = await client.call('list_claude_code_sessions', { imported: false })
  expect(sessions.json).toMatchObject({
    sessions: [{ sessionId: IMPORTED_SESSION, cwd: root, workspaceId: workspace?.id, taskId: null }],
  })
  const imported = await client.call('import_claude_code_session', { sessionId: IMPORTED_SESSION })
  expect(imported.json).toMatchObject({ imported: true, task: { title: IMPORTED_TITLE, state: 'done' } })
  await expect(list.sectionHeader('Done')).toHaveText('Done1')
  await list.sectionHeader('Done').click()
  await list.row('Done', IMPORTED_TITLE).click()
  await expect(taskHeader(window).title).toHaveText(IMPORTED_TITLE)
  await expect(chat(window).userMessages.first()).toContainText(IMPORTED_PROMPT)
  await expect(chat(window).agentReplies.first()).toContainText(IMPORTED_REPLY)
  // Importing it again returns the same task and changes nothing.
  const again = await client.call('import_claude_code_session', { sessionId: IMPORTED_SESSION })
  expect(again.json).toMatchObject({ imported: false, task: { id: (imported.json.task as { id: string }).id } })
  await expect(list.sectionHeader('Done')).toHaveText('Done1')
  await client.close()
})

test('Settings › Control: a regenerated token refuses the old one, a taken port falls back, and the switch off stops the endpoint', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  const modal = await openControl(glade)
  await modal.toggle('Let agents control Glade').click()
  const before = await shown(modal)
  const client = await connect(before.url, before.token)
  expect((await client.call('list_workspaces')).isError).toBe(false)

  // Regenerated: the old token is refused from the next request; the new one works.
  await modal.regenerateToken.click()
  await expect(modal.connectCommand).not.toContainText(before.token)
  const after = await shown(modal)
  expect(after.url).toBe(before.url)
  await expect(client.call('list_workspaces')).rejects.toThrow()
  await expect(connect(before.url, before.token)).rejects.toThrow()
  const fresh = await connect(after.url, after.token)
  expect((await fresh.call('list_workspaces')).isError).toBe(false)
  await fresh.close()

  // A port that's taken: the next one is used, and Control says so.
  const taken = await holdFreePort()
  try {
    await modal.port.fill(String(taken.port))
    await modal.port.press('Enter')
    await expect(modal.portNotice).toHaveText(
      `${String(taken.port)} is in use, so Glade is listening on ${String(taken.port + 1)}. A command copied before points at ${String(taken.port)}.`,
    )
    await expect(modal.endpoint).toHaveText(`http://127.0.0.1:${String(taken.port + 1)}/mcp`)
    const moved = await shown(modal)
    const onFallback = await connect(moved.url, moved.token)
    expect((await onFallback.call('list_workspaces')).isError).toBe(false)
    await onFallback.close()

    // Off: nothing listens.
    await modal.toggle('Let agents control Glade').click()
    await expect(modal.toggle('Let agents control Glade')).not.toBeChecked()
    await expect(modal.connectCommand).toBeHidden()
    await expect(connect(moved.url, moved.token)).rejects.toThrow()
    await expect(fetch(`${new URL(moved.url).origin}/v1/tools`)).rejects.toThrow()
  } finally {
    await taken.release()
  }
})

/** A free port, held as another app would hold it, whose next port is free too. */
async function holdFreePort(): Promise<{ port: number; release: () => Promise<void> }> {
  for (;;) {
    const port = 30_000 + Math.floor(Math.random() * 10_000)
    const held = await listen(port)
    if (held === null) continue
    const next = await listen(port + 1)
    if (next === null) {
      await held()
      continue
    }
    await next()
    return { port, release: held }
  }
}

/** Listens on a port of 127.0.0.1, hanging up on whoever connects: its release, or null when it's taken. */
function listen(port: number): Promise<(() => Promise<void>) | null> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.destroy()
    })
    server.once('error', () => {
      resolve(null)
    })
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      resolve(
        () =>
          new Promise((done) => {
            server.close(() => {
              done()
            })
          }),
      )
    })
  })
}
