import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { chooseMenuItem } from './menu'
import { chat, firstRun, inputBar, settings, taskList, toasts } from './selectors'

test('model and effort pickers: the built-in list first, then the SDK’s, with each model’s own levels, kept over a relaunch', async ({
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

  // No session has run yet: the built-in list, every effort level with it.
  await bar.setting('Model').click()
  await expect(bar.options('Model')).toHaveText(['Opus 5.5', 'Sonnet 5', 'Haiku 4.5'])
  await window.keyboard.press('Escape')
  await bar.setting('Effort').click()
  await expect(bar.options('Effort')).toHaveText(['Low', 'Medium', 'High', 'Extra high', 'Max'])
  await bar.option('Max').click()
  await expect(bar.setting('Effort')).toHaveAccessibleName('Effort: Max')

  // The first session reports the SDK's models: the pickers offer those from then on.
  await bar.field.fill('Add a Retry-After header.')
  await bar.field.press('Enter')
  await expect(chat(window).agentReplies.first()).toContainText('The client retries idempotent requests')
  await expect(bar.setting('Model')).toHaveAccessibleName('Model: Default (recommended)')
  await bar.setting('Model').click()
  await expect(bar.options('Model')).toHaveText(['Default (recommended)', 'Sonnet', 'Haiku'])
  await expect(bar.option('Default (recommended)')).toHaveAttribute('aria-checked', 'true')

  // Sonnet stops at Extra high: the task's Max falls back to High, and a toast says so.
  await bar.option('Sonnet').click()
  await expect(bar.setting('Model')).toHaveAccessibleName('Model: Sonnet')
  await expect(bar.setting('Effort')).toHaveAccessibleName('Effort: High')
  await expect(toasts(window).saying('Sonnet doesn’t offer Max effort, so it’s now High.')).toBeVisible()
  await bar.setting('Effort').click()
  await expect(bar.options('Effort')).toHaveText(['Low', 'Medium', 'High', 'Extra high'])
  await bar.option('Extra high').click()
  await expect(bar.setting('Effort')).toHaveAccessibleName('Effort: Extra high')

  // Haiku takes no effort: the picker hides.
  await bar.setting('Model').click()
  await bar.option('Haiku').click()
  await expect(bar.setting('Model')).toHaveAccessibleName('Model: Haiku')
  await expect(bar.setting('Effort')).toHaveCount(0)

  // A relaunch offers the SDK's models before any session runs, in Settings too.
  await glade.close()
  const relaunched = await launch()
  const again = inputBar(relaunched.window)
  await expect(again.setting('Model')).toHaveAccessibleName('Model: Haiku')
  await expect(again.setting('Effort')).toHaveCount(0)
  await again.setting('Model').click()
  await expect(again.options('Model')).toHaveText(['Default (recommended)', 'Sonnet', 'Haiku'])
  await again.option('Default (recommended)').click()
  // Haiku kept the task's Extra high for the next model that has it.
  await expect(again.setting('Effort')).toHaveAccessibleName('Effort: Extra high')

  const modal = settings(relaunched.window)
  await chooseMenuItem(relaunched, 'Glade', 'Settings…')
  await expect(modal.model).toHaveText('Default (recommended)')
  await modal.model.click()
  await expect(relaunched.window.getByRole('menu', { name: 'Model' }).getByRole('menuitemradio')).toHaveText([
    'Default (recommended)',
    'Sonnet',
    'Haiku',
  ])
  await relaunched.window.getByRole('menuitemradio', { name: 'Haiku', exact: true }).click()
  await expect(modal.model).toHaveText('Haiku')
  await expect(modal.dialog.getByRole('radiogroup', { name: 'Effort' })).toHaveCount(0)
})
