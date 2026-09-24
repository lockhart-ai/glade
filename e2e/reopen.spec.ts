import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { expect, test } from './fixtures'
import { chat, firstRun, inputBar, taskHeader, taskList, taskPanel, toasts } from './selectors'

/** The accessible names of the chat's messages and dividers, top to bottom. */
function chatOrder(log: Locator): Promise<(string | null)[]> {
  return log
    .locator('article, [role="separator"]')
    .evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')))
}

test('reopen by chatting: a message in a done task reopens it and the agent carries on', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'multi-tool-turn', chosenFolder: root })
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  await list.newTask.click()
  const bar = inputBar(window)
  const header = taskHeader(window)
  const conversation = chat(window)

  await bar.field.fill('The date test is flaky. Can you fix it?')
  await bar.field.press('Enter')
  await expect(conversation.agentReplies).toHaveCount(1)
  await expect(header.pill).toHaveText('Active · waiting on you')

  // Mark it done: the row moves to Done, the Undo toast shows, and the input bar says a message reopens it. Marking
  // done adds no divider.
  const { region, undo } = toasts(window)
  await list.sectionHeader('Done').click()
  await header.markDone.click()
  await expect(undo).toBeVisible()
  await expect(header.pill).toHaveText(/^Done · /)
  await expect(list.rows('Done')).toHaveCount(1)
  await expect(list.rows('Active')).toHaveCount(0)
  await expect(bar.field).toHaveAttribute('placeholder', 'Send a message to reopen this task…')
  await expect(conversation.markedDone).toHaveCount(0)

  // A message reopens it while the Undo toast is still up: the toast goes, the row moves back to Active, and the
  // header says when it was reopened and first done.
  await bar.field.fill('Check the report header too.')
  await bar.field.press('Enter')
  await expect(undo).toHaveCount(0)
  await expect(region).toBeEmpty()
  await expect(list.rows('Active')).toHaveCount(1)
  await expect(list.rows('Done')).toHaveCount(0)
  await expect(header.pill).toHaveText(/^Active · /)
  await expect(header.header).toContainText(/reopened just now · first done [A-Z][a-z]{2} \d{1,2}/)
  await expect(header.markDone).toBeVisible()

  // The chat marks when it was done, before your message, and that your message reopened it, after it.
  await expect(conversation.markedDone).toHaveText(/^Marked done · [A-Z][a-z]{2} \d{1,2}, \d\d:\d\d$/)
  await expect(conversation.reopened).toHaveText('Reopened by your message')

  // The agent answers in the same conversation, and the task waits on you again.
  await expect(conversation.agentReplies).toHaveCount(2)
  await expect(conversation.agentReplies.nth(1)).toContainText('The report header already goes through')
  await expect(header.pill).toHaveText('Active · waiting on you')
  await expect(header.field('Status')).toContainText('The report header uses the UTC date too.')
  expect(await chatOrder(conversation.log)).toEqual(['You', 'Agent', 'Marked done', 'You', 'Reopened', 'Agent'])

  // The tool log has the dividers too, before the new turn's.
  const { dividers } = taskPanel(window)
  await expect(dividers.filter({ hasText: /^marked done · / })).toHaveCount(1)
  await expect(dividers.filter({ hasText: /^reopened · / })).toHaveCount(1)
  await expect(dividers.filter({ hasText: /^turn 2 · / })).toHaveCount(1)
})
