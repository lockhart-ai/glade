import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { DEFAULT_COMPACT_SUMMARY, type AgentScriptName } from '../src/main/agent/scripts'
import { expect, test, type Glade, type LaunchOptions } from './fixtures'
import { chat, contextPopover, firstRun, inputBar, taskList, taskPanel } from './selectors'

/** What the default compaction carried over: its summary block, as the Compact row shows it. */
const CARRIED_OVER = /1\. Primary Request and Intent:\s+Move user image uploads from local disk to S3/

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
  // The Compact row opens to what the agent carried over: the summary, without the model's analysis.
  const panel = taskPanel(window)
  await panel.compactions.getByRole('button').click()
  await expect(panel.compactionSummaries).toHaveText(CARRIED_OVER)
  await expect(panel.compactionSummaries).not.toContainText('<analysis>')
  expect(DEFAULT_COMPACT_SUMMARY).toContain('<analysis>')
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

test('a long turn crosses the auto-compact threshold, compacts on its own and carries on, and it all stays after a relaunch', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const first = await launch({ agentScript: 'auto-compaction', chosenFolder: root })
  await firstRun(first.window).openFolder.click()
  await taskList(first.window).newTask.click()

  const bar = inputBar(first.window)
  await bar.field.fill('Move image uploads to S3 and copy the existing files over.')
  await bar.field.press('Enter')
  const { agentReplies, compacted, log, working } = chat(first.window)

  // Part way through the turn the context passes the SDK's threshold (97% of the default model's 1M window), and the
  // SDK compacts on its own: the agent is still working, and says so.
  await expect(bar.contextMeter).toHaveText('97% · 970k / 1M')
  await expect(working).toHaveText('Working · Compacting the context')
  await expect(agentReplies).toHaveCount(0)

  // The chat marks where, the tool log has an automatic Compact row, and the meter drops to what's left.
  const divider = 'Compacted automatically at 97% · 970k → 41k'
  const row = /Compact970k → 41k tokens.*Automatic · resuming from a summary/
  await expect(compacted).toHaveText(divider)
  await expect(taskPanel(first.window).compactions).toHaveText(row)
  await expect(bar.contextMeter).toHaveText('4% · 41k / 1M')

  // The turn carries on from the summary and its reply lands, after the divider.
  await expect(agentReplies).toHaveText([/^All 3,900 files are copied/])
  await expect(log).toHaveText(/Move image uploads.*Compacted automatically at 97%.*All 3,900 files are copied/s)
  await expect(working).toBeHidden()
  // Nothing from before the compaction is gone: the copy and the sample check are still in the tool log.
  const panel = taskPanel(first.window)
  await expect(panel.call(/copy_media_to_s3/)).toBeVisible()
  await expect(panel.call(/check_media_sample/)).toBeVisible()
  await first.close()

  // Relaunch: the chat, the divider, the Compact row and the meter are all still there.
  const { window } = await launch({ agentScript: 'auto-compaction' })
  const relaunched = chat(window)
  await expect(relaunched.userMessages).toHaveText([/Move image uploads to S3/])
  await expect(relaunched.compacted).toHaveText(divider)
  await expect(relaunched.agentReplies).toHaveText([/^All 3,900 files are copied/])
  await expect(taskPanel(window).compactions).toHaveText(row)
  await expect(taskPanel(window).call(/copy_media_to_s3/)).toBeVisible()
  await expect(taskPanel(window).call(/check_media_sample/)).toBeVisible()
  await expect(inputBar(window).contextMeter).toHaveText('4% · 41k / 1M')
  // What it carried over is still there to open.
  await taskPanel(window).compactions.getByRole('button').click()
  await expect(taskPanel(window).compactionSummaries).toHaveText(CARRIED_OVER)
})

/** Starts a task on `script` whose first turn leaves the default model's 1M window 95% full, and opens its meter. */
async function fillAndOpenMeter(
  launch: (options: LaunchOptions) => Promise<Glade>,
  folder: string,
  script: AgentScriptName,
): Promise<Page> {
  const root = join(folder, 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: script, chosenFolder: root })
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const bar = inputBar(window)
  await bar.field.fill('Move image uploads to S3 and copy the existing files over.')
  await bar.field.press('Enter')
  await expect(chat(window).agentReplies).toHaveCount(1)
  await expect(bar.contextMeter).toHaveText('95% · 950k / 1M')
  await bar.contextButton.click()
  await expect(contextPopover(window).popover).toBeVisible()
  return window
}

test("the meter's threshold follows the SDK: a user's settings that compact early move the marker and the note", async ({
  launch,
  tempFolder,
}) => {
  const window = await fillAndOpenMeter(launch, tempFolder(), 'compacts-early')
  const popover = contextPopover(window)
  await expect(popover.popover).toContainText('Compacts automatically at 60%.')
  await expect(popover.marker).toHaveAttribute('style', /left: 60%/)
  // Well past it, so the ring is purple.
  await expect(inputBar(window).contextMeter).toHaveClass(/near/)
})

test('with auto-compact switched off, the meter shows no threshold and never turns purple, and Compact now still works', async ({
  launch,
  tempFolder,
}) => {
  const window = await fillAndOpenMeter(launch, tempFolder(), 'never-auto-compacts')
  const popover = contextPopover(window)
  await expect(popover.popover).toContainText(
    'Auto-compact is off in your Claude Code settings, so it compacts only when you ask.',
  )
  await expect(popover.marker).toHaveCount(0)
  await expect(inputBar(window).contextMeter).not.toHaveClass(/near/)

  await popover.compactNow.click()
  await expect(chat(window).compacted).toHaveText('Compacted · 950k → 190k')
})
