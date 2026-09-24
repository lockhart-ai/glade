import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { chat, contextPopover, firstRun, inputBar, taskList, taskPanel } from './selectors'

test('the context meter opens a popover, and Compact now or ⌘⇧K compacts the context and drops the meter', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'long-context', chosenFolder: root })
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()

  // The scripted agent's turn leaves the default model's 1M window 95% full, near the auto-compact threshold.
  const bar = inputBar(window)
  await bar.field.fill('Move image uploads to S3 and copy the existing files over.')
  await bar.field.press('Enter')
  const { agentReplies, compacted, userMessages, working } = chat(window)
  await expect(agentReplies).toHaveCount(1)
  await expect(bar.contextMeter).toHaveText('95% · 950k / 1M')

  // The popover says how full it is and where the SDK compacts on its own.
  const popover = contextPopover(window)
  await bar.contextButton.click()
  await expect(popover.popover).toBeVisible()
  await expect(popover.usage).toHaveText('95% · 950k / 1M')
  await expect(popover.popover).toContainText('Compacts automatically at 97%.')
  await expect(popover.popover).toContainText('⌘⇧K')

  // Compact now: the agent works while it compacts, then the chat marks it and the meter drops.
  await popover.compactNow.click()
  await expect(popover.popover).toBeHidden()
  await expect(working).toHaveText('Working · Compacting the context')
  await expect(compacted).toHaveText('Compacted · 950k → 190k')
  await expect(bar.contextMeter).toHaveText('19% · 190k / 1M')
  await expect(taskPanel(window).compactions).toHaveText(/Compact950k → 190k tokens.*Resuming from a summary/)
  // `/compact` never shows as your message.
  await expect(userMessages).toHaveCount(1)
  await expect(chat(window).log).not.toContainText('/compact')

  // The next message is answered from the compacted context.
  await bar.field.fill('Now update the stored paths.')
  await bar.field.press('Enter')
  await expect(agentReplies).toHaveCount(2)
  await expect(bar.contextMeter).toHaveText('19% · 190k / 1M')

  // ⌘⇧K compacts again, from wherever the focus is.
  await bar.field.press('Meta+Shift+K')
  await expect(compacted).toHaveCount(2)
  await expect(compacted.nth(1)).toHaveText('Compacted · 190k → 38k')
  await expect(bar.contextMeter).toHaveText('4% · 38k / 1M')
})
