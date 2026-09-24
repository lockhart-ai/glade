import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { chooseMenuItem, menuItem } from './menu'
import { contextMenu, firstRun, inputBar, regions, settings, taskList } from './selectors'

// Playwright's key presses go to the page, never to the native menu bar, so the menu bar's keys (⌘N, ⌘B, ⌘⇧P…) are
// checked by the accelerators its items have, and chosen through `chooseMenuItem`; the window's own keys are pressed.
test('shortcuts: the window’s work, one rebound in Settings › Keyboard works by its new keys, a menu bar item takes its new key, and a relaunch keeps both', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  const field = inputBar(window).field
  const { taskPanel } = regions(window)
  const modal = settings(window)

  // File › New task (⌘N) makes a task, with the focus in its input bar.
  expect(await menuItem(glade, 'File', 'New task')).toMatchObject({ accelerator: 'CmdOrCtrl+N' })
  await chooseMenuItem(glade, 'File', 'New task')
  await expect(list.rows('Active')).toHaveCount(1)
  await expect(field).toBeFocused()

  // ⌘⌥2 picks the right panel's Files tab, even from the input bar; ⌘⌥1 goes back to Tool calls.
  await window.keyboard.press('Meta+Alt+Digit2')
  await expect(taskPanel.getByRole('tab', { name: /^Files/ })).toHaveAttribute('aria-selected', 'true')
  await window.keyboard.press('Meta+Alt+Digit1')
  await expect(taskPanel.getByRole('tab', { name: /^Tool calls/ })).toHaveAttribute('aria-selected', 'true')

  // ⌘P (Jump to task) puts the focus in the task search; ⌘L puts it back in the input bar; ⌘F searches again.
  await window.keyboard.press('Meta+KeyP')
  await expect(list.search).toBeFocused()
  await window.keyboard.press('Meta+KeyL')
  await expect(field).toBeFocused()
  await window.keyboard.press('Meta+KeyF')
  await expect(list.search).toBeFocused()
  await window.keyboard.press('Meta+KeyL')

  // Settings › Keyboard. Search tasks can't take ⌘B, which the menu bar's Toggle task list has, nor ⌘Q.
  await chooseMenuItem(glade, 'Glade', 'Settings…')
  await modal.section('Keyboard').click()
  await modal.keycap('Search tasks: ⌘F').click()
  await expect(modal.keycap('Search tasks: press the new keys')).toBeVisible()
  await window.keyboard.press('Meta+KeyB')
  await expect(modal.keyProblem).toHaveText('⌘B is already used by Toggle task list.')
  await modal.keycap('Search tasks: ⌘F').click()
  await window.keyboard.press('Meta+KeyQ')
  await expect(modal.keyProblem).toHaveText('⌘Q is reserved for Quit Glade.')

  // ⌃⇧F it is.
  await modal.keycap('Search tasks: ⌘F').click()
  await window.keyboard.press('Control+Shift+KeyF')
  await expect(modal.keycap('Search tasks: ⌃⇧F')).toBeVisible()
  await expect(modal.keyProblem).toHaveCount(0)
  await expect(modal.reset('Search tasks', '⌘F')).toBeVisible()

  // Pin / unpin, a menu bar item's, becomes ⌃⇧P: the Task menu's item takes the new key.
  await modal.keycap('Pin / unpin: ⌘⇧P').click()
  await window.keyboard.press('Control+Shift+KeyP')
  await expect(modal.keycap('Pin / unpin: ⌃⇧P')).toBeVisible()
  await expect.poll(async () => (await menuItem(glade, 'Task', 'Pin to top')).accelerator).toBe('Ctrl+Shift+P')
  await window.keyboard.press('Escape')
  await expect(modal.dialog).toBeHidden()

  // ⌘F does nothing now; ⌃⇧F searches. The task's menu shows Pin to top's new keys.
  await expect(field).toBeFocused()
  await window.keyboard.press('Meta+KeyF')
  await expect(field).toBeFocused()
  await window.keyboard.press('Control+Shift+KeyF')
  await expect(list.search).toBeFocused()
  await list.rows('Active').first().click({ button: 'right' })
  await expect(contextMenu(window, 'Task actions').menu).toContainText('Pin to top⌃⇧P')
  await window.keyboard.press('Escape')

  // After a relaunch, ⌃⇧F still searches, the Task menu still answers ⌃⇧P, and Settings › Keyboard shows both.
  await glade.close()
  const relaunched = await launch()
  const again = taskList(relaunched.window)
  await expect(again.rows('Active')).toHaveCount(1)
  await relaunched.window.keyboard.press('Control+Shift+KeyF')
  await expect(again.search).toBeFocused()
  await expect.poll(async () => (await menuItem(relaunched, 'Task', 'Pin to top')).accelerator).toBe('Ctrl+Shift+P')
  const keyboard = settings(relaunched.window)
  await chooseMenuItem(relaunched, 'Glade', 'Settings…')
  await keyboard.section('Keyboard').click()
  await expect(keyboard.keycap('Search tasks: ⌃⇧F')).toBeVisible()
  await expect(keyboard.keycap('Pin / unpin: ⌃⇧P')).toBeVisible()

  // Reset puts ⌘F and ⌘⇧P back.
  await keyboard.reset('Search tasks', '⌘F').click()
  await keyboard.reset('Pin / unpin', '⌘⇧P').click()
  await expect(keyboard.keycap('Search tasks: ⌘F')).toBeVisible()
  await expect
    .poll(async () => (await menuItem(relaunched, 'Task', 'Pin to top')).accelerator)
    .toBe('CmdOrCtrl+Shift+P')
  await relaunched.window.keyboard.press('Escape')
  await relaunched.window.keyboard.press('Meta+KeyL')
  await relaunched.window.keyboard.press('Meta+KeyF')
  await expect(again.search).toBeFocused()
})
