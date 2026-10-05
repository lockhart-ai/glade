import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { E2E_WINDOW_SIZE } from '../src/main/e2e'
import { expect, test } from './fixtures'
import { chooseMenuItem } from './menu'
import { chat, firstRun, inputBar, regions, settings, taskList, taskPanel } from './selectors'
import { MIN_WINDOW, resize } from './window-layout'

test('curates an OpenRouter route, monitors key usage and preserves Glade chat and log history across a relaunch', async ({
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
  const usage = window.getByRole('button', { name: 'OpenRouter usage' })
  await expect(usage).toContainText('$8.00')
  await usage.click()
  const usageDialog = window.getByRole('dialog', { name: 'OpenRouter usage' })
  await expect(usageDialog.getByRole('group', { name: 'Today · UTC' })).toContainText('$0.25')
  await expect(usageDialog.getByRole('group', { name: 'This month · UTC' })).toContainText('$12.00')
  await expect(usageDialog.getByRole('group', { name: 'Key spending limit' })).toContainText('monthly reset')
  await usageDialog.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(usageDialog.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
  if (media !== undefined) await usageDialog.screenshot({ path: join(media, 'openrouter-usage.png') })
  await usageDialog.press('Escape')
  await bar.setting('Model').click()
  await expect(bar.options('Model')).toHaveText([
    'Default (recommended)',
    'Sonnet',
    'Haiku',
    'Sample Flash · Sample Host',
  ])
  await bar.option('Sample Flash · Sample Host').click()
  await expect(bar.setting('Model')).toHaveAccessibleName('Model: Sample Flash · Sample Host')
  await bar.setting('Subagents').click()
  await bar.option('Sample Flash · Sample Host').click()
  await expect(bar.setting('Subagents')).toHaveAccessibleName('Subagents: Sample Flash · Sample Host')
  await resize(glade, MIN_WINDOW.width, MIN_WINDOW.height)
  const row = regions(window).inputBar.getByTestId('context-meter-slot').locator('..')
  expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  for (const name of ['Model', 'Subagents', 'Permissions'] as const) {
    await expect(bar.setting(name)).toBeInViewport({ ratio: 1 })
  }
  if (media !== undefined) await regions(window).inputBar.screenshot({ path: join(media, 'narrow-model-pickers.png') })
  await resize(glade, E2E_WINDOW_SIZE.width, E2E_WINDOW_SIZE.height)
  await expect(chat(window).agentReplies.first().getByRole('paragraph').first()).toHaveText(original)
  await taskPanel(window).tab('Agents').click()
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
  await expect(again.window.getByRole('button', { name: 'OpenRouter usage' })).toContainText('$8.00')
  await expect(inputBar(again.window).setting('Model')).toHaveAccessibleName('Model: Sample Flash · Sample Host')
  await expect(chat(again.window).agentReplies).toHaveCount(2)
  await taskPanel(again.window).tab('Agents').click()
  await expect(taskPanel(again.window).log).toContainText('Switched model to Sample Flash · Sample Host (OpenRouter)')
  await inputBar(again.window).setting('Model').click()
  await inputBar(again.window).option('Haiku').click()
  await expect(inputBar(again.window).setting('Model')).toHaveAccessibleName('Model: Haiku')
  await expect(taskPanel(again.window).log).toContainText('Switched model to Haiku')
  await expect(chat(again.window).agentReplies).toHaveCount(2)
  await chooseMenuItem(again, 'Glade', 'Settings…')
  const reopened = settings(again.window)
  await reopened.section('Models').click()
  await reopened.dialog.getByRole('button', { name: 'Remove', exact: true }).click()
  await reopened.close.click()
  await expect(again.window.getByRole('button', { name: 'OpenRouter usage' })).toHaveCount(0)
})
