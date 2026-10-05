import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { chooseMenuItem } from './menu'
import { chat, firstRun, inputBar, regions, settings, taskList, taskPanel } from './selectors'

test('curates an OpenRouter route and switches a task with its history intact across a relaunch', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'simple-reply', chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const bar = inputBar(window)
  await bar.field.fill('Add a Retry-After header.')
  await bar.field.press('Enter')
  await expect(chat(window).agentReplies.first()).toContainText('The client retries idempotent requests')
  const original = await chat(window).agentReplies.first().getByRole('paragraph').first().innerText()
  await chooseMenuItem(glade, 'Glade', 'Settings…')
  const modal = settings(window)
  await modal.section('Models').click()
  await modal.dialog.getByLabel('OpenRouter API key').fill('invalid')
  await modal.dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(modal.dialog.getByRole('alert')).toContainText('OpenRouter returned 401')
  await modal.dialog.getByLabel('OpenRouter API key').fill('fixture-key')
  await modal.dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(modal.dialog.getByText('Sample Flash', { exact: true })).toBeVisible()
  await modal.dialog.getByRole('button', { name: 'Provider for Sample Flash: Select provider' }).click()
  await window.getByRole('menuitemradio', { name: 'Sample Host', exact: true }).click()
  await modal.dialog.getByRole('checkbox', { name: 'Enable Sample Flash' }).click()
  await expect(modal.dialog.getByText('1 enabled', { exact: true })).toBeVisible()
  await modal.dialog.getByRole('button', { name: 'Filter providers: All providers' }).click()
  await window.getByRole('menuitemradio', { name: 'Sample Host', exact: true }).click()
  await expect(modal.dialog.getByText('Sample Flash', { exact: true })).toBeVisible()
  await modal.dialog.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(modal.dialog.getByRole('button', { name: 'Filter providers: All providers' })).toBeVisible()
  const media = process.env.GLADE_OPENROUTER_MEDIA_DIR
  if (media !== undefined) {
    mkdirSync(media, { recursive: true })
    await modal.dialog.screenshot({ path: join(media, 'settings-models.png') })
  }
  await modal.close.click()
  await bar.setting('Model').click()
  await expect(bar.options('Model')).toHaveText([
    'Default (recommended)',
    'Sonnet',
    'Haiku',
    'Sample Flash · Sample Host',
  ])
  await bar.option('Sample Flash · Sample Host').click()
  await expect(bar.setting('Model')).toHaveAccessibleName('Model: Sample Flash · Sample Host')
  await expect(chat(window).agentReplies.first().getByRole('paragraph').first()).toHaveText(original)
  await taskPanel(window).tab('Tool calls').click()
  await expect(taskPanel(window).log).toContainText('Switched model to Sample Flash · Sample Host (OpenRouter)')
  if (media !== undefined) await regions(window).task.screenshot({ path: join(media, 'task-model-switch.png') })
  await bar.setting('Subagents').click()
  await expect(bar.options('Subagents')).toHaveText(['Same as task', 'Sample Flash · Sample Host'])
  await bar.option('Same as task').click()
  await bar.field.fill('Continue with the same context.')
  await bar.field.press('Enter')
  await expect(chat(window).agentReplies).toHaveCount(2)
  await expect(chat(window).agentReplies.first().getByRole('paragraph').first()).toHaveText(original)
  await glade.close()
  const again = await launch({ agentScript: 'simple-reply' })
  await expect(inputBar(again.window).setting('Model')).toHaveAccessibleName('Model: Sample Flash · Sample Host')
  await expect(chat(again.window).agentReplies).toHaveCount(2)
  await taskPanel(again.window).tab('Tool calls').click()
  await expect(taskPanel(again.window).log).toContainText('Switched model to Sample Flash · Sample Host (OpenRouter)')
  await inputBar(again.window).setting('Model').click()
  await inputBar(again.window).option('Haiku').click()
  await expect(inputBar(again.window).setting('Model')).toHaveAccessibleName('Model: Haiku')
  await expect(taskPanel(again.window).log).toContainText('Switched model to Haiku')
  await expect(chat(again.window).agentReplies).toHaveCount(2)
})
