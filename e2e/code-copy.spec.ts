// Click to copy code, end to end with the scripted agent (#352): a code span in a reply copies its exact text on a
// plain click, a drag selection doesn't copy, Enter copies from the keyboard, and a fenced code block copies whole
// from its corner icon. Nothing reaches the real clipboard: e2e mode records what main copied (`desktop`).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { desktop, expect, test, type Glade } from './fixtures'
import { chat, firstRun, inputBar, taskList } from './selectors'

/** Opens the workspace, starts a task and sends it `message`. */
async function startTask(window: Page, message: string): Promise<void> {
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const bar = inputBar(window)
  await bar.field.fill(message)
  await bar.field.press('Enter')
}

/** What main has put on the clipboard, oldest first. */
async function copied(glade: Glade): Promise<string[]> {
  return (await desktop(glade)).copied
}

test('code copy: a span copies its text on click, not a drag, and Enter; a block copies whole from its icon', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'shares-code', chosenFolder: root })
  const { window } = glade
  await startTask(window, 'What’s the MX record for example.com?')
  const reply = chat(window).agentReplies.first()
  await expect(reply).toContainText('mail.example.com')

  // A hovered code span: a pointer, and a brighter background.
  const mxRecord = reply.locator('code', { hasText: /^mail\.example\.com$/ })
  await mxRecord.hover()
  await expect(mxRecord).toHaveCSS('cursor', 'pointer')

  // A plain click copies its exact text, with Copied shown for a moment, then gone again.
  await mxRecord.click()
  await expect(mxRecord.getByRole('status')).toHaveText('Copied')
  await expect.poll(() => copied(glade)).toEqual(['mail.example.com'])
  await expect(mxRecord.getByRole('status')).toHaveCount(0)

  // Dragging to select part of the span leaves it as ordinary selection: no second copy.
  const aRecord = reply.locator('code', { hasText: /^203\.0\.113\.7$/ })
  const box = await aRecord.boundingBox()
  if (box === null) throw new Error('No bounding box for the A record’s span')
  await window.mouse.move(box.x + 2, box.y + box.height / 2)
  await window.mouse.down()
  await window.mouse.move(box.x + box.width - 2, box.y + box.height / 2)
  await window.mouse.up()
  await expect.poll(() => copied(glade)).toEqual(['mail.example.com'])

  // Clearing the selection and clicking again copies it.
  await window.mouse.click(10, 10)
  await aRecord.click()
  await expect.poll(() => copied(glade)).toEqual(['mail.example.com', '203.0.113.7'])

  // Enter, from the keyboard, copies too.
  await mxRecord.focus()
  await window.keyboard.press('Enter')
  await expect.poll(() => copied(glade)).toEqual(['mail.example.com', '203.0.113.7', 'mail.example.com'])

  // The fenced code block's corner icon, shown on hover, copies the whole block.
  const block = reply.locator('pre', { hasText: 'dig +short mail.example.com' })
  const copyBlock = block.getByRole('button', { name: 'Copy code' })
  await block.hover()
  await expect(copyBlock).toBeVisible()
  await copyBlock.click()
  await expect(block.getByRole('button', { name: 'Copied' })).toBeVisible()
  await expect
    .poll(() => copied(glade))
    .toEqual(['mail.example.com', '203.0.113.7', 'mail.example.com', 'dig +short mail.example.com\n'])
})
