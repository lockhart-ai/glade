import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, seedPath, test } from './fixtures'
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

// #416: a session at 1M on a model id without `[1m]` read "905k / 200k", and a task on `opus[1m]`, which the SDK's list
// didn't have, showed the raw id and wasn't in its own picker.
test('context meter and model picker: a 1M session reads 1M whatever its model id, and its model is named and listed', async ({
  launch,
}) => {
  const first = await launch({ seed: seedPath('context-window.json') })
  const bar = inputBar(first.window)

  // 905k used can't be of a 200k window: the meter shows the 1M it proves, and the label says so.
  await expect(bar.contextMeter).toHaveText('91% · 905k / 1M')
  await expect(bar.setting('Model')).toHaveAccessibleName('Model: Opus 5.5 (1M)')
  await bar.contextButton.click()
  await expect(first.window.getByRole('dialog', { name: 'Context' })).toContainText('Compacts automatically at 97%')
  await first.window.keyboard.press('Escape')

  // The task on `opus[1m]`: a friendly name, and in the list right after its base model, checked.
  await taskList(first.window).taskRow('Map the webhook retries').click()
  await expect(bar.contextMeter).toHaveText('87% · 867k / 1M')
  await expect(bar.setting('Model')).toHaveAccessibleName('Model: Opus 5.5 (1M)')
  await bar.setting('Model').click()
  await expect(bar.options('Model')).toHaveText([
    'Default (recommended)',
    'Opus 5.5',
    'Opus 5.5 (1M)',
    'Fable 5.1',
    'Sonnet 5',
    'Haiku 4.5',
    'Opus 5',
    'Sonnet 4.6',
  ])
  await expect(bar.option('Opus 5.5 (1M)')).toHaveAttribute('aria-checked', 'true')
  await first.window.keyboard.press('Escape')
  await first.close()

  // The window is the task's own, in SQLite: a relaunch reads it back, with no session running.
  const { window } = await launch()
  await expect(inputBar(window).contextMeter).toHaveText('87% · 867k / 1M')
  await expect(inputBar(window).setting('Model')).toHaveAccessibleName('Model: Opus 5.5 (1M)')
  await taskList(window).taskRow('Audit the request handlers').click()
  await expect(inputBar(window).contextMeter).toHaveText('91% · 905k / 1M')
})
