import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { chat, firstRun, inputBar, taskList } from './selectors'

test('context meter: empty for a new task, fills from the agent’s usage, and stays after a relaunch', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const first = await launch({ agentScript: 'multi-tool-turn', chosenFolder: root })
  await firstRun(first.window).openFolder.click()
  await taskList(first.window).newTask.click()

  // A new task on the default model (its 1M-context variant) has used none of it.
  const meter = inputBar(first.window).contextMeter
  await expect(meter).toHaveText('0% · 0k / 1M')

  // The scripted agent's messages each used 22,846 tokens of context: 10 input, 1,272 cache creation, 21,564 cache read.
  const bar = inputBar(first.window)
  await bar.field.fill('The date test fails in some timezones. Fix it.')
  await bar.field.press('Enter')
  await expect(chat(first.window).agentReplies.first()).toContainText('all 148 tests pass')
  await expect(meter).toHaveText('2% · 23k / 1M')
  await expect(meter).toHaveAttribute('aria-valuenow', '2')
  await first.close()

  // The usage is saved on the task, so a relaunch shows it straight away.
  const { window } = await launch({ agentScript: 'multi-tool-turn' })
  await expect(chat(window).agentReplies).toHaveCount(1)
  await expect(inputBar(window).contextMeter).toHaveText('2% · 23k / 1M')
})
