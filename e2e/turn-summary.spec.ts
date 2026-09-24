import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { chat, firstRun, inputBar, taskList } from './selectors'

test('turn summary: each finished turn says how long it took and what it changed, after a relaunch too', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const first = await launch({ agentScript: 'multi-tool-turn', chosenFolder: root })
  await firstRun(first.window).openFolder.click()
  await taskList(first.window).newTask.click()

  const bar = inputBar(first.window)
  await bar.field.fill('The date test is flaky. Can you fix it?')
  await bar.field.press('Enter')

  // The turn edited one file, one line out and one in; the summary sits beside its tool-call chip.
  const { agentReplies, turnSummaries } = chat(first.window)
  await expect(agentReplies).toHaveCount(1)
  const firstReply = agentReplies.first()
  await expect(firstReply.getByRole('button', { name: /tool calls$/ })).toBeVisible()
  await expect(firstReply.getByRole('note', { name: 'Turn summary' })).toHaveText(/^Finished in \d+s · 1 file \+1 −1$/)

  // A turn that changed no files says only how long it took.
  await bar.field.fill('Does the report header need the same fix?')
  await bar.field.press('Enter')
  await expect(agentReplies).toHaveCount(2)
  await expect(turnSummaries).toHaveCount(2)
  await expect(turnSummaries.nth(1)).toHaveText(/^Finished in \d+s$/)
  const shown = await turnSummaries.allTextContents()
  await first.close()

  // Both are saved: a relaunch shows them as they were.
  const { window } = await launch({ agentScript: 'multi-tool-turn' })
  await expect(chat(window).agentReplies).toHaveCount(2)
  await expect(chat(window).turnSummaries).toHaveText(shown)
})
