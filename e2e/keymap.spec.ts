import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { contextMenu, firstRun, inputBar, regions, settings, taskList } from './selectors'

test('shortcuts: a representative set works, one rebound in Settings › Keyboard works by its new keys, and a relaunch keeps it', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  const { sidebar, taskPanel } = regions(window)
  const modal = settings(window)

  // ⌘N makes a task, with the focus in its input bar.
  await window.keyboard.press('Meta+KeyN')
  await expect(list.rows('Active')).toHaveCount(1)
  await expect(inputBar(window).field).toBeFocused()

  // ⌘⌥2 picks the right panel's Files tab, even from the input bar; ⌘⌥1 goes back to Tool calls.
  await window.keyboard.press('Meta+Alt+Digit2')
  await expect(taskPanel.getByRole('tab', { name: /^Files/ })).toHaveAttribute('aria-selected', 'true')
  await window.keyboard.press('Meta+Alt+Digit1')
  await expect(taskPanel.getByRole('tab', { name: /^Tool calls/ })).toHaveAttribute('aria-selected', 'true')

  // ⌘B hides the task list and shows it again; ⌘P (Jump to task) then puts the focus in its search field.
  await window.keyboard.press('Meta+KeyB')
  await expect(sidebar).toBeHidden()
  await window.keyboard.press('Meta+KeyB')
  await expect(sidebar).toBeVisible()
  await window.keyboard.press('Meta+KeyP')
  await expect(list.search).toBeFocused()

  // ⌘⇧P pins the selected task, and its menu says so beside Unpin.
  await window.keyboard.press('Meta+Shift+KeyP')
  await expect(list.rows('Pinned')).toHaveCount(1)
  await list.rows('Pinned').first().click({ button: 'right' })
  await expect(contextMenu(window, 'Task actions').menu).toContainText('Unpin⌘⇧P')
  await window.keyboard.press('Escape')

  // ⌘, opens Settings. Keyboard lists the shortcuts; Pin / unpin can't take ⌘B, which Toggle task list has.
  await window.keyboard.press('Meta+Comma')
  await modal.section('Keyboard').click()
  await modal.keycap('Pin / unpin: ⌘⇧P').click()
  await expect(modal.keycap('Pin / unpin: press the new keys')).toBeVisible()
  await window.keyboard.press('Meta+KeyB')
  await expect(modal.keyProblem).toHaveText('⌘B is already used by Toggle task list.')
  // Nor ⌘Q, which quits.
  await modal.keycap('Pin / unpin: ⌘⇧P').click()
  await window.keyboard.press('Meta+KeyQ')
  await expect(modal.keyProblem).toHaveText('⌘Q is reserved for Quit Glade.')

  // ⌃⇧P it is.
  await modal.keycap('Pin / unpin: ⌘⇧P').click()
  await window.keyboard.press('Control+Shift+KeyP')
  await expect(modal.keycap('Pin / unpin: ⌃⇧P')).toBeVisible()
  await expect(modal.keyProblem).toHaveCount(0)
  await expect(modal.reset('Pin / unpin', '⌘⇧P')).toBeVisible()
  await window.keyboard.press('Escape')
  await expect(modal.dialog).toBeHidden()
  // The keys pressed while recording were only that: ⌘B didn't hide the task list.
  await expect(sidebar).toBeVisible()

  // ⌘⇧P does nothing now; ⌃⇧P unpins, and the menu shows the new keys.
  await window.keyboard.press('Meta+Shift+KeyP')
  await expect(list.rows('Pinned')).toHaveCount(1)
  await window.keyboard.press('Control+Shift+KeyP')
  await expect(list.rows('Pinned')).toHaveCount(0)
  await list.rows('Active').first().click({ button: 'right' })
  await expect(contextMenu(window, 'Task actions').menu).toContainText('Pin to top⌃⇧P')
  await window.keyboard.press('Escape')

  // After a relaunch, ⌃⇧P still pins, and Settings › Keyboard still shows it, with Reset.
  await glade.close()
  const relaunched = await launch()
  const again = taskList(relaunched.window)
  await expect(again.rows('Active')).toHaveCount(1)
  await again.rows('Active').first().click()
  await relaunched.window.keyboard.press('Control+Shift+KeyP')
  await expect(again.rows('Pinned')).toHaveCount(1)
  const keyboard = settings(relaunched.window)
  await relaunched.window.keyboard.press('Meta+Comma')
  await keyboard.section('Keyboard').click()
  await expect(keyboard.keycap('Pin / unpin: ⌃⇧P')).toBeVisible()

  // Reset puts ⌘⇧P back.
  await keyboard.reset('Pin / unpin', '⌘⇧P').click()
  await expect(keyboard.keycap('Pin / unpin: ⌘⇧P')).toBeVisible()
  await relaunched.window.keyboard.press('Escape')
  await relaunched.window.keyboard.press('Meta+Shift+KeyP')
  await expect(again.rows('Pinned')).toHaveCount(0)
})
