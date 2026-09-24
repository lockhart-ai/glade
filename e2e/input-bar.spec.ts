import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { firstRun, inputBar, notifications, taskList } from './selectors'

test('input bar: ⌘L focuses it, ⇧↵ adds a line, the pickers persist, and ↵ sends', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ chosenFolder: root })
  await firstRun(glade.window).openFolder.click()
  await taskList(glade.window).newTask.click()
  const bar = inputBar(glade.window)

  await expect(bar.setting('Model')).toHaveText('ModelOpus 5.5')
  await expect(bar.setting('Effort')).toHaveText('EffortHigh')
  await expect(bar.setting('Permissions')).toHaveText('PermissionsAllow all')
  await expect(bar.field).toHaveAttribute('placeholder', 'Reply…')
  await expect(bar.send).toBeEnabled()
  await expect(bar.stop).toHaveCount(0)

  // ⌘L focuses the field from anywhere.
  await taskList(glade.window).search.focus()
  await glade.window.keyboard.press('Meta+L')
  await expect(bar.field).toBeFocused()

  // ⇧↵ adds a line, and the field grows with what you type, up to a limit.
  const startHeight = (await bar.field.boundingBox())?.height ?? 0
  await glade.window.keyboard.type('Add a Retry-After header.')
  await glade.window.keyboard.press('Shift+Enter')
  await glade.window.keyboard.type('Keep the 429 body short.')
  await expect(bar.field).toHaveValue('Add a Retry-After header.\nKeep the 429 body short.')
  for (let line = 0; line < 3; line += 1) await glade.window.keyboard.press('Shift+Enter')
  await expect.poll(async () => (await bar.field.boundingBox())?.height ?? 0).toBeGreaterThan(startHeight)
  for (let line = 0; line < 20; line += 1) await glade.window.keyboard.press('Shift+Enter')
  await expect.poll(async () => (await bar.field.boundingBox())?.height).toBe(240)
  await bar.field.fill('Add a Retry-After header.')

  // The pickers change the task's model and effort, which it keeps.
  await bar.setting('Model').click()
  await bar.option('Sonnet 5').click()
  await expect(bar.setting('Model')).toHaveText('ModelSonnet 5')
  await bar.setting('Effort').click()
  await expect(bar.option('High')).toHaveAttribute('aria-checked', 'true')
  await bar.option('Low').click()
  await expect(bar.setting('Effort')).toHaveText('EffortLow')

  // ↵ sends. The e2e app has no scripted agent to answer yet (#101), so the send fails, the message stays in the field
  // and a toast says why.
  await bar.field.focus()
  await glade.window.keyboard.press('Enter')
  await expect(notifications(glade.window)).toContainText('Couldn’t send your message')
  await expect(bar.field).toHaveValue('Add a Retry-After header.')

  await glade.close()
  const relaunched = inputBar((await launch()).window)
  await expect(relaunched.setting('Model')).toHaveText('ModelSonnet 5')
  await expect(relaunched.setting('Effort')).toHaveText('EffortLow')
})
