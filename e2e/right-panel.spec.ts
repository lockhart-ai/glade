import type { Locator } from '@playwright/test'
import { expect, seedPath, test } from './fixtures'
import { chooseMenuItem } from './menu'
import { regions, taskHeader, taskPanel } from './selectors'

/** A laid-out element's width, in CSS pixels. */
async function widthOf(locator: Locator): Promise<number> {
  return (await locator.boundingBox())?.width ?? 0
}

test('right panel: ⌘⌥2 picks a tab; dragging the handle resizes it, kept on relaunch; ⌘⌥B collapses and reopens it', async ({
  launch,
}) => {
  const glade = await launch({ seed: seedPath('tool-log.json') })
  const { window } = glade
  const panel = taskPanel(window)

  // Seven tabs, with counts only where there's something to count.
  await expect(panel.panel.getByRole('tab')).toHaveText([
    'Tool calls 6',
    'Files',
    'Todos',
    'Artifacts',
    'Subagents 1',
    'Watchers',
    'Changes',
  ])

  // ⌘⌥2 picks Files, wherever the focus is.
  await window.keyboard.press('Meta+Alt+Digit2')
  await expect(panel.tab('Files')).toHaveAttribute('aria-selected', 'true')
  await expect(panel.tabPanel).toContainText('No file open.')

  // Dragging the handle left widens the panel by as much, and the chat gives up the room.
  await expect.poll(() => widthOf(panel.panel)).toBe(440)
  const chatBefore = await widthOf(regions(window).chat)
  const handle = await panel.resizeHandle.boundingBox()
  if (handle === null) throw new Error('The resize handle is not laid out')
  const x = handle.x + handle.width / 2
  const y = handle.y + handle.height / 2
  await window.mouse.move(x, y)
  await window.mouse.down()
  await window.mouse.move(x - 100, y, { steps: 5 })
  await window.mouse.move(x - 200, y, { steps: 5 })
  await window.mouse.up()
  await expect.poll(() => widthOf(panel.panel)).toBe(640)
  expect(await widthOf(regions(window).chat)).toBe(chatBefore - 200)

  // Focused, → narrows it a step.
  await panel.resizeHandle.focus()
  await window.keyboard.press('ArrowRight')
  await expect.poll(() => widthOf(panel.panel)).toBe(624)

  // A relaunch keeps the width and the tab.
  await glade.close()
  const relaunched = await launch()
  const again = taskPanel(relaunched.window)
  await expect(again.tab('Files')).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => widthOf(again.panel)).toBe(624)

  // View › Toggle right panel (⌘⌥B) collapses the panel, the chat takes its room, and the header offers it back; it
  // reopens it too.
  const header = taskHeader(relaunched.window)
  await chooseMenuItem(relaunched, 'View', 'Toggle right panel')
  await expect(again.panel).toBeHidden()
  await expect(header.showSidePanel).toBeVisible()
  await chooseMenuItem(relaunched, 'View', 'Toggle right panel')
  await expect.poll(() => widthOf(again.panel)).toBe(624)
  await expect(header.showSidePanel).toBeHidden()

  // The collapse button collapses it too, and the header's button brings it back. Collapsed stays collapsed.
  await again.collapse.click()
  await expect(again.panel).toBeHidden()
  await relaunched.close()
  const third = await launch()
  await expect(taskPanel(third.window).panel).toBeHidden()
  await taskHeader(third.window).showSidePanel.click()
  await expect(taskPanel(third.window).tab('Files')).toHaveAttribute('aria-selected', 'true')
})
