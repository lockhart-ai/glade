import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { desktop, expect, test } from './fixtures'
import { contextMenu, deleteTaskDialog, firstRun, inputBar, taskHeader, taskList } from './selectors'

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

test('task context menu: the items per the reference, rename, copy a link, and delete with confirm → cancel → confirm', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  const menu = contextMenu(window, 'Task actions')

  await list.newTask.click()
  await list.newTask.click()
  await expect(list.rows('Active')).toHaveCount(2)

  // Right-clicking an active task's row opens its menu, with the items and keys of docs/context-menus.md.
  await list.rows('Active').first().click({ button: 'right' })
  await expect(menu.items).toHaveText([
    'Open↵',
    'Pin to top⌘⇧P',
    'Rename…F2',
    'Mark as unread⌘⇧U',
    'Mark done⌘⇧D',
    'Copy link to task',
    'Delete task…',
  ])

  // Rename… turns the row's title into a field, as F2 does.
  await menu.item('Rename…').click()
  await expect(menu.menu).toHaveCount(0)
  await expect(list.renameField).toBeFocused()
  await list.renameField.fill('Add rate limiting to public API')
  await window.keyboard.press('Enter')
  await expect(list.rows('Active').first()).toContainText('Add rate limiting to public API')

  // ⇧F10 opens the focused row's menu; Copy link to task copies its glade:// link.
  await list.rows('Active').first().focus()
  await window.keyboard.press('Shift+F10')
  await expect(menu.menu).toBeVisible()
  await menu.item('Copy link to task').click()
  await expect.poll(async () => (await desktop(glade)).copied).toEqual([expect.stringMatching(/^glade:\/\/task\/.+/)])

  // Delete task… asks first: Cancel keeps the task.
  const dialog = deleteTaskDialog(window)
  await list.rows('Active').first().click({ button: 'right' })
  await menu.item('Delete task…').click()
  await expect(dialog.dialog).toContainText('Delete “Add rate limiting to public API”?')
  await dialog.cancel.click()
  await expect(dialog.dialog).toHaveCount(0)
  await expect(list.rows('Active')).toHaveCount(2)

  // Asked again, Delete deletes it.
  await list.rows('Active').first().click({ button: 'right' })
  await menu.item('Delete task…').click()
  await dialog.confirm.click()
  await expect(list.rows('Active')).toHaveCount(1)
  await expect(list.taskRow('Add rate limiting to public API')).toHaveCount(0)

  // A done task's menu reopens it and copies its outcome instead.
  await list.rows('Active').first().click({ button: 'right' })
  await menu.item('Mark done').click()
  await expect(list.rows('Done')).toHaveCount(1)
  await list.rows('Done').first().click({ button: 'right' })
  await expect(menu.items).toHaveText([
    'Open↵',
    'Pin to top',
    'Rename…',
    'Reopen',
    'Copy link to task',
    'Copy outcome',
    'Delete task…',
  ])
  await menu.item('Reopen').click()
  await expect(list.rows('Active')).toHaveCount(1)
})
