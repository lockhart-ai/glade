// Links in a todo's text (P16, #500), end to end with the scripted agent and the hidden `todoHubEnabled` setting on:
// where a todo's title or status line names a PR, an issue or a ticket the task has as a link artifact, those words
// are a link to it, which behaves as every link in the app does and never opens or closes the todo. Adding the link
// later turns the words into a link, and removing it turns them back. Also the hub's two empty states.
//
// Nothing reaches a real browser or the clipboard: e2e mode records what main opened and copied (`desktop`).
import { mkdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Page } from '@playwright/test'
import { FILES_CHILDREN } from '../src/main/agent/scripts'
import { CommandName } from '../src/shared/bridge'
import { ArtifactKind } from '../src/shared/domain'
import { desktop, expect, test } from './fixtures'
import { chat, contextMenu, firstRun, inputBar, taskHeader, taskList, taskPanel, todoHub } from './selectors'
import { invoke } from './task-view'

/** The hub's sample data (screens 46 to 49): a task in flight, whose todos name the PRs and issues it has as links. */
const HUB_SEED = resolve(__dirname, '../scripts/fixtures/todo-hub.json')

const SHIP = 'Ship the rate-limit fixes for 2.5'
const ISSUE_501 = 'https://github.com/acme/api/issues/501'
const ISSUE_503 = 'https://github.com/acme/api/issues/503'
const PR_511 = 'https://github.com/acme/api/pull/511'
const PR_513 = 'https://github.com/acme/api/pull/513'

/** The only task's id, as main has it. */
async function onlyTaskId(window: Page): Promise<string> {
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const { tasks } = await invoke(window, CommandName.TasksList, { workspaceId: workspaces[0]?.id ?? '' })
  return tasks[0]?.id ?? ''
}

test('the todo hub: a PR or an issue a todo names is a link to the task’s own, and opens in the browser without opening the todo', async ({
  launch,
}) => {
  const glade = await launch({ seed: HUB_SEED })
  const { window } = glade
  const hub = todoHub(window)
  const page = window.url()
  await expect(taskHeader(window).title).toHaveText(SHIP)

  // The first todo's title names an issue the task has, and its status line a PR it has: each is a link to it, and
  // the text reads as it did.
  const first = hub.head('Return Retry-After on 429s')
  await expect(first).toHaveText('Doing: #501 Return Retry-After on 429sCI failed on PR #511 · fixing')
  await expect(hub.links(first)).toHaveText(['#501', 'PR #511'])
  const issue = hub.links(first).first()
  const pr = hub.links(first).last()
  await expect(issue).toHaveAttribute('href', ISSUE_501)
  await expect(issue).toHaveAttribute('title', ISSUE_501)
  await expect(pr).toHaveAttribute('href', PR_511)
  await expect(pr).toHaveAttribute('title', PR_511)
  // A todo that names nothing has none, and a done todo's title links as any does.
  await expect(hub.links(hub.head('Draft the 2.5 release notes'))).toHaveCount(0)
  await expect(hub.links(hub.head('Document the rate limits'))).toHaveText(['#503'])
  await expect(hub.links(hub.head('Document the rate limits'))).toHaveAttribute('href', ISSUE_503)
  // The second names a PR the task has, in its status line, and an issue it has, in its title.
  const second = hub.head('Per-key limits for /search')
  await expect(hub.links(second)).toHaveText(['#502', 'PR #513'])

  // It's the app's link: no underline until the pointer is on it.
  await expect(pr).toHaveCSS('text-decoration-line', 'none')
  await pr.hover()
  await expect(pr).toHaveCSS('text-decoration-line', 'underline')
  await expect(pr).toHaveCSS('cursor', 'pointer')

  // Clicking one opens it in the browser, through main, and leaves the todo as it is: the first open, the second
  // closed.
  await expect(first).toHaveAttribute('aria-expanded', 'true')
  await pr.click()
  await issue.click()
  await expect(second).toHaveAttribute('aria-expanded', 'false')
  await hub.links(second).last().click()
  await expect.poll(async () => (await desktop(glade)).opened).toEqual([PR_511, ISSUE_501, PR_513])
  await expect(first).toHaveAttribute('aria-expanded', 'true')
  await expect(second).toHaveAttribute('aria-expanded', 'false')
  await expect(hub.tiles(hub.card('Return Retry-After'))).toHaveCount(7)
  expect(window.url()).toBe(page)
  expect(glade.app.windows()).toHaveLength(1)

  // Tab from the todo reaches its links in order, each with the focus ring, and ↵ opens the one with the focus.
  await first.focus()
  await expect(first).toBeFocused()
  await window.keyboard.press('Tab')
  await expect(issue).toBeFocused()
  await expect(issue).toHaveCSS('outline-style', 'solid')
  await window.keyboard.press('Tab')
  await expect(pr).toBeFocused()
  await window.keyboard.press('Enter')
  await expect.poll(async () => (await desktop(glade)).opened).toEqual([PR_511, ISSUE_501, PR_513, PR_511])
  await expect(first).toHaveAttribute('aria-expanded', 'true')
  // The arrow keys on it move nothing: they're the todo's only while the todo has the focus.
  await window.keyboard.press('ArrowLeft')
  await window.keyboard.press('ArrowDown')
  await expect(pr).toBeFocused()
  await expect(first).toHaveAttribute('aria-expanded', 'true')

  // Its menu is the link's own, not the todo's, with nothing to add: the task has it already.
  const linkMenu = contextMenu(window, 'Link actions')
  await pr.click({ button: 'right' })
  await expect(linkMenu.items).toHaveText(['Open link', 'Copy link'])
  await expect(window.getByRole('menu', { name: 'Todo actions' })).toHaveCount(0)
  await linkMenu.item('Copy link').click()
  await expect.poll(async () => (await desktop(glade)).copied).toEqual([PR_511])
  await expect(first).toHaveAttribute('aria-expanded', 'true')
})

test('the todo hub: the words become a link when the task gets the link, and text again when it loses it; and its empty states', async ({
  launch,
  tempFolder,
}) => {
  const root = join(realpathSync(tempFolder()), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'files-children', chosenFolder: root })
  const { window } = glade
  const hub = todoHub(window)
  const panel = taskPanel(window)
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const taskId = await onlyTaskId(window)
  await invoke(window, CommandName.SettingsUpdate, { patch: { todoHubEnabled: true } })

  // A task with nothing at all, neither a todo nor anything made, has the Todos tab's own centred empty state.
  await panel.tab(/^Todos/).click()
  await expect(hub.nothing).toBeVisible()
  await expect(hub.nothing).toHaveCSS('text-align', 'center')
  await expect(panel.tabPanel).toHaveText('No todos yet.')
  await expect(hub.noTodos).toHaveCount(0)

  // The agent keeps three todos; one names a PR, in its title and its status line. The task has no link for it yet.
  await inputBar(window).field.fill(FILES_CHILDREN.prompt)
  await inputBar(window).field.press('Enter')
  await expect(chat(window).agentReplies.first()).toContainText(FILES_CHILDREN.named.reply)
  const watch = hub.head('Watch CI on PR #42')
  await expect(watch).toHaveText(/^Doing: Watch CI on PR #42Watching CI on PR #42$/)
  await expect(hub.nothing).toHaveCount(0)
  await expect(hub.links(watch)).toHaveCount(0)
  await expect(panel.tabPanel.getByRole('link')).toHaveCount(0)

  // The task gets the PR as a link (as Add to artifacts adds one): the words are links to it, in both lines.
  const api = 'https://github.com/acme/api/pull/42'
  const web = 'https://github.com/acme/web/pull/42'
  await invoke(window, CommandName.ArtifactsAddLink, { taskId, url: api, text: '' })
  await expect(hub.links(watch)).toHaveText(['PR #42', 'PR #42'])
  await expect(hub.links(watch).first()).toHaveAttribute('href', api)
  await expect(hub.links(watch).last()).toHaveAttribute('title', api)
  await expect(watch).toHaveText(/^Doing: Watch CI on PR #42Watching CI on PR #42$/)
  await hub.links(watch).first().click()
  await expect.poll(async () => (await desktop(glade)).opened).toEqual([api])

  // A second link with the same number, in another repository: it could mean either, so it's text.
  await invoke(window, CommandName.ArtifactsAddLink, { taskId, url: web, text: '' })
  await expect(hub.links(watch)).toHaveCount(0)

  // With the first gone it means the one that's left, and with both gone it's text again.
  await invoke(window, CommandName.ArtifactsRemove, { taskId, ref: { kind: ArtifactKind.Link, url: api } })
  await expect(hub.links(watch)).toHaveText(['PR #42', 'PR #42'])
  await expect(hub.links(watch).first()).toHaveAttribute('href', web)
  await invoke(window, CommandName.ArtifactsRemove, { taskId, ref: { kind: ArtifactKind.Link, url: web } })
  await expect(hub.links(watch)).toHaveCount(0)
  await expect(watch).toHaveText(/^Doing: Watch CI on PR #42Watching CI on PR #42$/)

  // With the switch off, the Todos tab is the plain list, and a todo naming the task's PR is text.
  await invoke(window, CommandName.ArtifactsAddLink, { taskId, url: api, text: '' })
  await expect(hub.links(watch)).toHaveCount(2)
  await invoke(window, CommandName.SettingsUpdate, { patch: { todoHubEnabled: false } })
  await expect(hub.heads).toHaveCount(0)
  await expect(panel.todos.filter({ hasText: 'Watch CI on PR #42' })).toHaveCount(1)
  await expect(panel.tabPanel.getByRole('link')).toHaveCount(0)
})
