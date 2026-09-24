/**
 * The macOS menu bar, for the specs. Playwright can't click the native menu, and its key presses go to the page, never
 * to the menu bar, so the menu bar's keys (⌘N, ⌘B, ⌘1 – ⌘9, F2…) can't be pressed from a spec either: a spec chooses
 * the item instead, which runs the same command. The items are found by their labels, e.g. `Task`, `Mark done`.
 */
import { expect } from '@playwright/test'
import type { MenuItem } from 'electron'
import type { Glade } from './fixtures'

/** A menu bar item as a spec sees it. */
export interface MenuBarItem {
  readonly label: string
  readonly enabled: boolean
  readonly checked: boolean
  readonly accelerator: string | null
}

/** The item at `path` (a menu's label, then each submenu's), or null when there's none. */
export async function findMenuItem({ app }: Glade, path: readonly string[]): Promise<MenuBarItem | null> {
  return app.evaluate(({ Menu }, labels) => {
    let items = Menu.getApplicationMenu()?.items ?? []
    let found: MenuItem | undefined
    for (const label of labels) {
      found = items.find((item) => item.label === label)
      items = found?.submenu?.items ?? []
    }
    if (found === undefined) return null
    const { label, enabled, checked } = found
    return { label, enabled, checked, accelerator: found.accelerator ?? null }
  }, path)
}

/** The item at `path`, once the menu bar has one. */
export async function menuItem(glade: Glade, ...path: string[]): Promise<MenuBarItem> {
  await expect.poll(() => findMenuItem(glade, path), { message: `No menu bar item ${path.join(' › ')}` }).not.toBeNull()
  const item = await findMenuItem(glade, path)
  if (item === null) throw new Error(`No menu bar item ${path.join(' › ')}`)
  return item
}

/**
 * Chooses the item at `path`, as clicking it (or pressing its key) would, once it's enabled: the window reports what
 * it shows to main, which rebuilds the menu bar, so an item can take a moment to catch up.
 */
export async function chooseMenuItem(glade: Glade, ...path: string[]): Promise<void> {
  await expect
    .poll(async () => (await findMenuItem(glade, path))?.enabled ?? false, {
      message: `Menu bar item ${path.join(' › ')} never became enabled`,
    })
    .toBe(true)
  await glade.app.evaluate(({ Menu }, labels) => {
    let items = Menu.getApplicationMenu()?.items ?? []
    let found: MenuItem | undefined
    for (const label of labels) {
      found = items.find((item) => item.label === label)
      items = found?.submenu?.items ?? []
    }
    found?.click()
  }, path)
}
