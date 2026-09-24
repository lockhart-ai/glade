import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { firstRun, inputBar, taskHeader, taskList } from './selectors'

test('task actions: F2 renames a task inline, ⌘⇧P pins and unpins it, ⌘⇧U marks it unread, and all of it persists', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  const header = taskHeader(window)

  // Two tasks; the newer one is selected, with the focus in the input bar.
  await list.newTask.click()
  await list.newTask.click()
  await expect(list.rows('Active')).toHaveCount(2)
  await expect(inputBar(window).field).toBeFocused()

  // F2 turns the selected row's title into a field, even from the input bar. ↵ saves the new title.
  await window.keyboard.press('F2')
  await expect(list.renameField).toBeFocused()
  await expect(list.renameField).toHaveValue('')
  await list.renameField.fill('Add rate limiting to public API')
  await window.keyboard.press('Enter')
  await expect(list.renameField).toHaveCount(0)
  await expect(list.rows('Active').first()).toContainText('Add rate limiting to public API')
  await expect(header.title).toHaveText('Add rate limiting to public API')

  // A blank title is refused: the field stays. Esc cancels, keeping the title.
  await window.keyboard.press('F2')
  await expect(list.renameField).toHaveValue('Add rate limiting to public API')
  await list.renameField.fill('   ')
  await window.keyboard.press('Enter')
  await expect(list.renameField).toHaveAttribute('aria-invalid', 'true')
  await list.renameField.fill('Something else')
  await window.keyboard.press('Escape')
  await expect(list.renameField).toHaveCount(0)
  await expect(list.rows('Active').first()).toContainText('Add rate limiting to public API')

  // ⌘⇧P pins the selected task: it moves under Pinned, and the header's pin shows it. ⌘⇧P again unpins it.
  await window.keyboard.press('Meta+Shift+P')
  await expect(list.rows('Pinned')).toHaveCount(1)
  await expect(list.rows('Pinned').first()).toContainText('Add rate limiting to public API')
  await expect(header.unpin).toHaveAttribute('aria-pressed', 'true')
  await window.keyboard.press('Meta+Shift+P')
  await expect(list.rows('Pinned')).toHaveCount(0)
  await expect(header.pin).toHaveAttribute('aria-pressed', 'false')

  // Pin it again to keep across the relaunch, then mark it unread with ⌘⇧U: it stays selected, bold with the dot.
  await window.keyboard.press('Meta+Shift+P')
  await expect(list.rows('Pinned')).toHaveCount(1)
  await window.keyboard.press('Meta+Shift+U')
  const renamed = list.row('Pinned', 'Add rate limiting to public API')
  await expect(renamed.getByRole('img', { name: 'Unread' })).toBeVisible()
  await expect(renamed).toHaveAttribute('aria-current', 'true')

  // Select the other task (which reads nothing), then relaunch: the title, the pin and the unread mark are kept.
  await list.rows('Active').first().click()
  await glade.close()
  const relaunched = taskList((await launch()).window)
  const kept = relaunched.row('Pinned', 'Add rate limiting to public API')
  await expect(kept).toBeVisible()
  await expect(kept.getByRole('img', { name: 'Unread' })).toBeVisible()
  await expect(relaunched.rows('Active')).toHaveCount(1)
})
