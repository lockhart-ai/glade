import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chooseFolder, expect, notifications, test } from './fixtures'
import { chat, firstRun, inputBar, settings, taskList, workspaceSwitcher } from './selectors'

/** Task A's first message: it plays `multi-tool-turn`, which titles the task and replies after a dozen tool calls. */
const FIX_DATE = 'The date test is flaky. Can you fix it?'
/** The title A's agent gives it. */
const A_TITLE = 'Fix the flaky date test'

test('settings save as you change them: new tasks take the defaults, notifications stay off, and a relaunch keeps them', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScriptsByFirstMessage: { [FIX_DATE]: 'multi-tool-turn' }, chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  const bar = inputBar(window)
  const modal = settings(window)

  // ⌘, opens Settings at Agent, with the defaults for new tasks.
  await window.keyboard.press('Meta+Comma')
  await expect(modal.dialog).toBeVisible()
  await expect(modal.heading).toHaveText('Agent')
  await expect(modal.model).toHaveText('Opus 5.5')
  await expect(modal.choice('Effort', 'High')).toBeChecked()
  await expect(modal.choice('Permissions', 'Allow all')).toBeChecked()

  // Each change saves as it's made: there's no Save button.
  await modal.model.click()
  await window.getByRole('menuitemradio', { name: 'Sonnet 5', exact: true }).click()
  await expect(modal.model).toHaveText('Sonnet 5')
  await modal.choice('Effort', 'Low').click()
  await expect(modal.choice('Effort', 'Low')).toBeChecked()

  // Notifications, off.
  await modal.section('Notifications').click()
  await expect(modal.heading).toHaveText('Notifications')
  await expect(modal.toggle('Sound')).not.toBeChecked()
  await modal.toggle('Notifications').click()
  await expect(modal.toggle('Notifications')).not.toBeChecked()

  // Keyboard lists the shortcuts, read-only.
  await modal.section('Keyboard').click()
  await expect(modal.dialog.getByRole('region', { name: 'Global' })).toContainText('Settings⌘,')
  await window.keyboard.press('Escape')
  await expect(modal.dialog).toBeHidden()

  // A new task starts on the new defaults.
  await list.newTask.click()
  await expect(bar.setting('Model')).toHaveAccessibleName('Model: Sonnet 5')
  await expect(bar.setting('Effort')).toHaveAccessibleName('Effort: Low')

  // A's reply arrives while you're on another task: it's unread, but with notifications off, nothing is shown.
  await bar.field.fill(FIX_DATE)
  await bar.field.press('Enter')
  await list.newTask.click()
  await expect(chat(window).newTaskPrompt).toBeVisible()
  await expect(list.taskRow(A_TITLE).getByRole('img', { name: 'Unread' })).toBeVisible()
  expect(await notifications(glade)).toEqual([])

  // A relaunch keeps every setting.
  await glade.close()
  const relaunched = await launch()
  const again = settings(relaunched.window)
  await relaunched.window.keyboard.press('Meta+Comma')
  await expect(again.model).toHaveText('Sonnet 5')
  await expect(again.choice('Effort', 'Low')).toBeChecked()
  await again.section('Notifications').click()
  await expect(again.toggle('Notifications')).not.toBeChecked()
  await again.close.click()
  await expect(again.dialog).toBeHidden()
})

test('Workspace settings… opens Settings › Workspace, which renames the workspace and moves its root folder', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  const moved = join(tempFolder(), 'acme')
  mkdirSync(root)
  mkdirSync(moved)
  const glade = await launch({ chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  const modal = settings(window)
  const sidebarWorkspace = window.getByRole('region', { name: 'Workspace' })

  // The switcher's Workspace settings… opens Settings at the workspace.
  const switcher = workspaceSwitcher(window)
  await switcher.trigger.click()
  await switcher.action('Workspace settings…').click()
  await expect(modal.heading).toHaveText('acme-api')
  await expect(modal.section('acme-api')).toHaveAttribute('aria-current', 'page')

  const name = modal.dialog.getByRole('textbox', { name: 'Workspace name' })
  await name.fill('Acme API')
  await name.press('Enter')
  await expect(modal.heading).toHaveText('Acme API')

  await chooseFolder(glade, moved)
  await modal.dialog.getByRole('button', { name: 'Change…' }).click()
  await expect(modal.dialog).toContainText(moved)

  // The sidebar shows the workspace as it now is.
  await modal.close.click()
  await expect(sidebarWorkspace).toContainText('Acme API')
  await expect(sidebarWorkspace).toContainText(moved)
})
