import type { Locator } from '@playwright/test'
import { expect, seedPath, test, type Glade } from './fixtures'
import { chooseMenuItem } from './menu'
import { installFixture } from './fixture-plugin'
import { expectViewOverSlot, openPlugins, pluginCard, pluginView } from './plugin-view'
import { contextMenu, panelToggles, regions, resizeHandles, settings, taskList, terminal } from './selectors'
import { boxOf, drag, MIN_WINDOW, resize } from './window-layout'

/** The window the e2e app opens at (src/main/e2e.ts), the design's. */
const DESIGN_WINDOW = { width: 1920, height: 1200 } as const

/** The plugin card's default width and its minimum, and the terminal's minimum beside it (src/renderer/panels/panelSize.ts). */
const PLUGIN = { initial: 680, min: 280 } as const
const MIN_TERMINAL_WIDTH = 360

/** The window's outer padding and the gap between the terminal and the plugin card (`--space-outer`). */
const OUTER = 8

/** The widest the plugin card can be in a window this wide: all but the padding, the gap and the terminal's minimum. */
function pluginRoom(width: number): number {
  return width - 2 * OUTER - OUTER - MIN_TERMINAL_WIDTH
}

const widthOf = async (locator: Locator): Promise<number> => (await boxOf(locator)).width

/** Waits for the plugin card to show at this width, with its view over its body. */
async function expectPluginWidth(glade: Glade, width: number): Promise<void> {
  await expect.poll(() => widthOf(resizeHandles(glade.window).pluginSlot)).toBe(width)
  expect(await widthOf(pluginCard(glade).card)).toBe(width)
  await expectViewOverSlot(glade)
}

/** Waits for the plugin's view to be hidden, its page kept. */
async function expectViewHidden(glade: Glade): Promise<void> {
  await expect.poll(async () => (await pluginView(glade))?.visible).toBe(false)
}

test('plugin split: dragging the handle resizes the plugin card within its limits, the arrow keys step it, and a relaunch keeps it', async ({
  launch,
  userData,
}) => {
  installFixture(userData)
  const glade = await launch()
  const { window } = glade
  const handles = resizeHandles(window)
  const { terminal: terminalCard } = regions(window)
  await expect(pluginCard(glade).status).toHaveText(/said hello$/)
  await expect(handles.plugin).toHaveAttribute('aria-orientation', 'vertical')

  // The design's width to start with.
  await expectPluginWidth(glade, PLUGIN.initial)

  // Dragging the handle left widens the card, and the terminal gives up the room; the view follows.
  const terminalBefore = await widthOf(terminalCard)
  await drag(window, handles.plugin, -120, 0)
  await expectPluginWidth(glade, PLUGIN.initial + 120)
  expect(await widthOf(terminalCard)).toBe(terminalBefore - 120)

  // Past its limits it stops: the terminal keeps its minimum, and the card its own.
  await drag(window, handles.plugin, -3000, 0)
  await expectPluginWidth(glade, pluginRoom(DESIGN_WINDOW.width))
  expect(await widthOf(terminalCard)).toBe(MIN_TERMINAL_WIDTH)
  await drag(window, handles.plugin, 3000, 0)
  await expectPluginWidth(glade, PLUGIN.min)

  // Focused, ← widens it a step and → narrows it.
  await drag(window, handles.plugin, PLUGIN.min - 500, 0)
  await expectPluginWidth(glade, 500)
  await handles.plugin.focus()
  await window.keyboard.press('ArrowLeft')
  await window.keyboard.press('ArrowLeft')
  await window.keyboard.press('ArrowRight')
  await expectPluginWidth(glade, 516)

  // A relaunch keeps it.
  await glade.close()
  const relaunched = await launch()
  await expect(pluginCard(relaunched).status).toHaveText(/said hello$/)
  await expectPluginWidth(relaunched, 516)
})

test('plugin split: a smaller window holds the plugin card to the room there is and a bigger one gives it back; collapsing the bar and turning the plugin off and on keep its width', async ({
  launch,
  userData,
}) => {
  installFixture(userData)
  const glade = await launch()
  const { window } = glade
  const handles = resizeHandles(window)
  await expect(pluginCard(glade).status).toHaveText(/said hello$/)

  // As wide as it goes in the design's window, then the window shrinks to its minimum: the terminal keeps its minimum.
  await drag(window, handles.plugin, -3000, 0)
  await expectPluginWidth(glade, pluginRoom(DESIGN_WINDOW.width))
  await resize(glade, MIN_WINDOW.width, MIN_WINDOW.height)
  await expectPluginWidth(glade, pluginRoom(MIN_WINDOW.width))
  expect(await widthOf(regions(window).terminal)).toBe(MIN_TERMINAL_WIDTH)

  // The handle starts from the width it shows: a small drag right narrows it from there, not from the stored width.
  await drag(window, handles.plugin, 40, 0)
  await expectPluginWidth(glade, pluginRoom(MIN_WINDOW.width) - 40)

  // A bigger window gives the card the width it was left at.
  await drag(window, handles.plugin, -3000, 0)
  await resize(glade, DESIGN_WINDOW.width, DESIGN_WINDOW.height)
  await expectPluginWidth(glade, pluginRoom(MIN_WINDOW.width))
  await drag(window, handles.plugin, pluginRoom(MIN_WINDOW.width) - 600, 0)
  await expectPluginWidth(glade, 600)

  // A width saved for a bigger window than the one it opens in is held to the room there is, and kept for later.
  await drag(window, handles.plugin, -3000, 0)
  await glade.close()
  const small = await launch()
  await resize(small, MIN_WINDOW.width, MIN_WINDOW.height)
  await expect(pluginCard(small).status).toHaveText(/said hello$/)
  await expectPluginWidth(small, pluginRoom(MIN_WINDOW.width))
  await resize(small, DESIGN_WINDOW.width, DESIGN_WINDOW.height)
  await expectPluginWidth(small, pluginRoom(DESIGN_WINDOW.width))
  await drag(small.window, resizeHandles(small.window).plugin, pluginRoom(DESIGN_WINDOW.width) - 600, 0)
  await expectPluginWidth(small, 600)

  // Collapsed, the card shows its header only, with no handle and its view hidden; open, it's back at its width.
  const smallToggles = panelToggles(small.window)
  const smallHandles = resizeHandles(small.window)
  await smallToggles.collapseBottomBar.click()
  await expect(smallHandles.plugin).toBeHidden()
  await expectViewHidden(small)
  await smallToggles.showBottomBar.click()
  await expect(smallHandles.plugin).toBeVisible()
  await expectPluginWidth(small, 600)

  // Turned off, the terminal takes the whole bar and there's no handle; turned on again, the card is back at its width.
  const modal = await openPlugins(small)
  await modal.toggle('Fixture').click()
  await modal.close.click()
  await expect(pluginCard(small).card).toBeHidden()
  await expect(smallHandles.plugin).toBeHidden()
  const again = await openPlugins(small)
  await again.toggle('Fixture').click()
  await again.close.click()
  await expect(pluginCard(small).status).toHaveText(/said hello$/)
  await expectPluginWidth(small, 600)
})

test('plugin split: the plugin view hides while Settings or a menu is over it, and comes back after; a menu elsewhere leaves it', async ({
  launch,
  userData,
}) => {
  installFixture(userData)
  const glade = await launch({ seed: seedPath('tool-log.json') })
  const { window } = glade
  const handles = resizeHandles(window)
  await expect(pluginCard(glade).status).toHaveText(/said hello$/)
  await expectViewOverSlot(glade)

  // Settings covers the whole window: the view hides while it's open, and is back over its slot once it closes.
  const modal = settings(window)
  await chooseMenuItem(glade, 'Glade', 'Settings…')
  await expect(modal.dialog).toBeVisible()
  await expectViewHidden(glade)
  await modal.close.click()
  await expect(modal.dialog).toBeHidden()
  await expectViewOverSlot(glade)

  // A task's context menu, up in the task list, is nowhere near it: the view stays.
  await taskList(window).rows('Active').first().click({ button: 'right' })
  const taskMenu = contextMenu(window, 'Task actions')
  await expect(taskMenu.menu).toBeVisible()
  expect((await pluginView(glade))?.visible).toBe(true)
  await window.keyboard.press('Escape')
  await expect(taskMenu.menu).toBeHidden()

  // The plugin card as wide as it goes, a terminal tab's menu opens over it: the view hides, and is back after.
  await drag(window, handles.plugin, -3000, 0)
  await expectViewOverSlot(glade)
  // Its menu opens at the pointer and runs right from there: from the fourth tab it reaches over the plugin card.
  const term = terminal(window)
  for (let count = 1; count <= 4; count += 1) {
    await term.newTab.click()
    await expect(term.tabs).toHaveCount(count)
  }
  const tab = term.tabs.last()
  const tabBox = await boxOf(tab)
  await tab.click({ button: 'right', position: { x: tabBox.width - 4, y: tabBox.height / 2 } })
  const tabMenu = contextMenu(window, 'Terminal tab actions')
  await expect(tabMenu.menu).toBeVisible()
  const menuBox = await boxOf(tabMenu.menu)
  expect(menuBox.x + menuBox.width).toBeGreaterThan((await boxOf(window.getByTestId('plugin-view-slot'))).x)
  await expectViewHidden(glade)
  await window.keyboard.press('Escape')
  await expect(tabMenu.menu).toBeHidden()
  await expectViewOverSlot(glade)
})
