import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { firstRun, inputBar, taskList } from './selectors'

test('task list: new tasks show live, ⌥↑/⌥↓ move the selection, and a collapsed section stays collapsed', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ chosenFolder: root })
  await firstRun(glade.window).openFolder.click()
  const list = taskList(glade.window)

  await expect(list.search).toBeVisible()
  await expect(list.section('Active')).toContainText('Active0')

  // + creates a task, which shows at the top of Active, selected.
  await list.newTask.click()
  await expect(list.rows('Active')).toHaveCount(1)
  await expect(list.rows('Active').first()).toContainText('New task')
  await expect(list.rows('Active').first()).toContainText('Waiting for instructions')
  await list.newTask.click()
  await expect(list.rows('Active')).toHaveCount(2)
  await expect(list.section('Active')).toContainText('Active2')
  await expect(list.rows('Active').first()).toHaveAttribute('aria-current', 'true')

  // ⌥↓ and ⌥↑ move through the list, from outside the input bar too (task-switching.spec.ts drives them from it).
  await inputBar(glade.window).field.blur()
  await glade.window.keyboard.press('Alt+ArrowDown')
  await expect(list.rows('Active').nth(1)).toHaveAttribute('aria-current', 'true')
  await glade.window.keyboard.press('Alt+ArrowUp')
  await expect(list.rows('Active').first()).toHaveAttribute('aria-current', 'true')

  // Collapsing a section hides its rows, and it's still collapsed after a relaunch.
  await list.sectionHeader('Active').click()
  await expect(list.sectionHeader('Active')).toHaveAttribute('aria-expanded', 'false')
  await expect(list.rows('Active')).toHaveCount(0)

  await glade.close()
  const relaunched = taskList((await launch()).window)
  await expect(relaunched.sectionHeader('Active')).toHaveAttribute('aria-expanded', 'false')
  await expect(relaunched.section('Active')).toContainText('Active2')
  await relaunched.sectionHeader('Active').click()
  await expect(relaunched.rows('Active')).toHaveCount(2)
})
