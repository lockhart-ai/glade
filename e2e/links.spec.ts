// Links, end to end with the scripted agent (#349): a link in a reply, the header, a tool log note, a command's
// output or a todo opens in the browser through main, by click, ⌘-click or ↵, and never in the window; its own menu
// opens or copies it. Nothing reaches a real browser or the clipboard: e2e mode records what main opened and copied
// (`desktop`).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { desktop, expect, test, type Glade } from './fixtures'
import { chat, contextMenu, firstRun, inputBar, taskHeader, taskList, taskPanel } from './selectors'

/** Opens the workspace, starts a task and sends it `message`. */
async function startTask(window: Page, message: string): Promise<void> {
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const bar = inputBar(window)
  await bar.field.fill(message)
  await bar.field.press('Enter')
}

/** The links main has opened in the browser, oldest first. */
async function opened(glade: Glade): Promise<string[]> {
  return (await desktop(glade)).opened
}

test('links: open in the browser from a reply, the header, the tool log and todos, never in the window', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'shares-links', chosenFolder: root })
  const { window } = glade
  const page = window.url()
  await startTask(window, 'What are the public API’s rate limits?')
  const reply = chat(window).agentReplies.first()
  await expect(reply).toContainText('curl https://example.com/api/health')

  // A Markdown link, with its address on hover, and a bare URL; the URL in code is no link.
  const docs = reply.getByRole('link', { name: 'the API docs' })
  await expect(docs).toHaveAttribute('title', 'https://example.com/docs/limits')
  const status = reply.getByRole('link', { name: 'https://example.com/status' })
  await expect(status).not.toHaveAttribute('title')
  await expect(reply.getByRole('link')).toHaveCount(2)
  await expect(reply.locator('code')).toHaveText('curl https://example.com/api/health')

  // Hovering underlines it, with a pointer.
  await docs.hover()
  await expect(docs).toHaveCSS('text-decoration-line', 'underline')
  await expect(docs).toHaveCSS('cursor', 'pointer')

  // A click and a ⌘-click open it through main; the window stays on its page and opens no other.
  await docs.click()
  await status.click({ modifiers: ['Meta'] })
  await expect.poll(() => opened(glade)).toEqual(['https://example.com/docs/limits', 'https://example.com/status'])
  expect(window.url()).toBe(page)
  expect(glade.app.windows()).toHaveLength(1)

  // ↵ on a focused link opens it too.
  await docs.focus()
  await window.keyboard.press('Enter')
  await expect.poll(async () => (await opened(glade)).length).toBe(3)

  // Its own menu, over the reply's: Open link and Copy link.
  const linkMenu = contextMenu(window, 'Link actions')
  await status.click({ button: 'right' })
  await expect(linkMenu.items).toHaveText(['Open link', 'Copy link'])
  await expect(window.getByRole('menu', { name: 'Reply actions' })).toHaveCount(0)
  await linkMenu.item('Copy link').click()
  await expect.poll(async () => (await desktop(glade)).copied).toEqual(['https://example.com/status'])

  // The header's goal and status.
  const header = taskHeader(window)
  await header.field('Goal').getByRole('link').click()
  await header.field('Now').getByRole('link').click()

  // A working note and a command's output in the tool log.
  const panel = taskPanel(window)
  await panel.tab(/^Tool calls/).click()
  await panel.log.getByRole('paragraph').filter({ hasText: 'Checking what' }).getByRole('link').click()
  await panel.call(/Bash/).click()
  await panel.log.getByLabel('Bash output').getByRole('link', { name: 'https://example.com/docs/health' }).click()

  // A todo.
  await panel.tab('Todos').click()
  // Done items list last, after the one in progress.
  await panel.todos.filter({ hasText: 'Read https' }).getByRole('link').click()

  await expect
    .poll(async () => (await opened(glade)).slice(3))
    .toEqual([
      'https://example.com/docs/limits',
      'https://example.com/status',
      'https://example.com/docs/limits',
      'https://example.com/docs/health',
      'https://example.com/docs/limits',
    ])
  expect(window.url()).toBe(page)
  expect(glade.app.windows()).toHaveLength(1)
})
