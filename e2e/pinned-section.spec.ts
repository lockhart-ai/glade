// The sidebar's Pinned section (#456): hidden while nothing is pinned, so it doesn't take a row for an empty header;
// shown again as soon as something is pinned, and gone again once the last pinned task is unpinned. Its collapsed
// state is kept the whole time, so a folded Pinned section comes back folded, and ⌥↑ / ⌥↓ keep working, skipping it
// while it's collapsed and crossing into and out of it once it's open. ⌘⌥↓ and the other ways to pin (the context
// menu, the shortcut) are covered in task-actions.spec.ts; this spec is about the section itself.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { firstRun, inputBar, taskHeader, taskList } from './selectors'

test('pinned section: hidden while nothing is pinned, appears on pinning, keeps its collapsed state, and survives a relaunch', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-shipping')
  mkdirSync(root)
  const glade = await launch({ chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  const header = taskHeader(window)

  // Two tasks, nothing pinned: no Pinned section at all, not even an empty header.
  await list.newTask.click()
  await list.newTask.click()
  await expect(list.rows('Active')).toHaveCount(2)
  await expect(list.section('Pinned')).toHaveCount(0)

  // Pinning the first task (the header's pin button) makes the section appear, expanded by default.
  await header.pin.click()
  await expect(list.section('Pinned')).toHaveCount(1)
  await expect(list.rows('Pinned')).toHaveCount(1)
  await expect(list.sectionHeader('Pinned')).toHaveAttribute('aria-expanded', 'true')

  // Collapse it, then unpin the only pinned task: the section (and its collapsed state) goes with it.
  await list.sectionHeader('Pinned').click()
  await expect(list.sectionHeader('Pinned')).toHaveAttribute('aria-expanded', 'false')
  await header.unpin.click()
  await expect(list.section('Pinned')).toHaveCount(0)

  // Pin it again: the section comes back folded, as it was left, not reset to expanded.
  await header.pin.click()
  await expect(list.section('Pinned')).toHaveCount(1)
  await expect(list.sectionHeader('Pinned')).toHaveAttribute('aria-expanded', 'false')
  await expect(list.rows('Pinned')).toHaveCount(0)

  // ⌥↓ / ⌥↑ skip the collapsed Pinned section, as they skip any other collapsed section: with the selected (pinned,
  // hidden) task out of the visible order, ⌥↑ goes to the one Active task.
  await inputBar(window).field.blur()
  await window.keyboard.press('Alt+ArrowUp')
  await expect(list.rows('Active').first()).toHaveAttribute('aria-current', 'true')

  // Expand it again: now the order runs Pinned, then Active, and the arrows cross the boundary both ways.
  await list.sectionHeader('Pinned').click()
  await expect(list.rows('Pinned')).toHaveCount(1)
  await window.keyboard.press('Alt+ArrowUp')
  await expect(list.rows('Pinned').first()).toHaveAttribute('aria-current', 'true')
  await window.keyboard.press('Alt+ArrowDown')
  await expect(list.rows('Active').first()).toHaveAttribute('aria-current', 'true')

  // The section, expanded, and the pin, survive a relaunch.
  await glade.close()
  const relaunchedWindow = (await launch()).window
  const relaunched = taskList(relaunchedWindow)
  await expect(relaunched.section('Pinned')).toHaveCount(1)
  await expect(relaunched.sectionHeader('Pinned')).toHaveAttribute('aria-expanded', 'true')
  await expect(relaunched.rows('Pinned')).toHaveCount(1)

  // Unpinning the last pinned task after the relaunch still hides the section.
  await relaunched.rows('Pinned').first().click()
  await taskHeader(relaunchedWindow).unpin.click()
  await expect(relaunched.section('Pinned')).toHaveCount(0)
})
