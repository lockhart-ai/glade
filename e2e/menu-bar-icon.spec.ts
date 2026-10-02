import { clickMenuBarIcon, expect, menuBarIcon, seedPath, test } from './fixtures'
import { chooseMenuItem } from './menu'
import { menuBarPopover, regions, settings, taskHeader, taskList } from './selectors'

/** The seed's tasks (e2e/seeds/menu-bar.json). */
const WORKING = 'Fix the flaky date test'
const NEEDS_YOU = 'Migrate the billing webhooks'
const DONE = 'Draft the release notes'

test("Glade's icon in the menu bar counts what needs you, and its popover opens Glade on a task", async ({
  launch,
}) => {
  const glade = await launch({ seed: seedPath('menu-bar.json') })
  const { window } = glade

  // The icon: one task needs you, so its count is beside the glyph. An agent works too, which the icon doesn't show.
  await expect.poll(() => menuBarIcon(glade)).toMatchObject({ shown: true, title: '1', open: false })

  // Clicking it opens the popover, listing what's in flight across both workspaces.
  const page = await clickMenuBarIcon(glade)
  const popover = menuBarPopover(page)
  await expect.poll(() => menuBarIcon(glade)).toMatchObject({ open: true })
  const needsYou = popover.row('Needs you', NEEDS_YOU)
  await expect(popover.rows('Needs you')).toHaveCount(1)
  await expect(needsYou).toContainText('Billing')
  await expect(needsYou).toContainText('Unread reply')
  const working = popover.row('Working', WORKING)
  await expect(popover.rows('Working')).toHaveCount(1)
  await expect(working).toContainText('Running the timezone tests')
  await expect(popover.todoProgress(working)).toHaveText('2/4')
  await expect(working).toContainText(/1[23]m \d\ds/)
  await expect(popover.row('Recent', NEEDS_YOU)).toContainText('Which endpoint should the webhooks keep?')
  await expect(popover.row('Recent', NEEDS_YOU)).toContainText('4m ago')
  // A done task is in nothing.
  await expect(popover.dialog).not.toContainText(DONE)

  // Clicking a row opens Glade on that task, in its own workspace, and hides the popover.
  await expect(regions(window).workspace).toContainText('Acme API')
  await needsYou.click()
  await expect(taskHeader(window).title).toHaveText(NEEDS_YOU)
  await expect(regions(window).workspace).toContainText('Billing')
  await expect(taskList(window).taskRow(NEEDS_YOU)).toHaveAttribute('aria-current', 'true')
  await expect.poll(() => menuBarIcon(glade)).toMatchObject({ open: false })

  // It stays up to date. Opening the task read its reply, so it no longer needs you and the count goes (#430).
  await expect.poll(() => menuBarIcon(glade)).toMatchObject({ title: '' })
  // Marked unread, it needs you again; marking it done then takes it out of Needs you, though an agent works.
  await chooseMenuItem(glade, 'Task', 'Mark as unread')
  await expect.poll(() => menuBarIcon(glade)).toMatchObject({ title: '1' })
  await clickMenuBarIcon(glade)
  await expect(popover.rows('Needs you')).toHaveCount(1)
  await taskHeader(window).markDone.click()
  await expect(popover.section('Needs you')).toHaveCount(0)
  await expect(popover.rows('Working')).toHaveCount(1)
  await expect.poll(() => menuBarIcon(glade)).toMatchObject({ title: '' })

  // Esc hides it; a working row opens its task back in the first workspace.
  await page.keyboard.press('Escape')
  await expect.poll(() => menuBarIcon(glade)).toMatchObject({ open: false })
  await clickMenuBarIcon(glade)
  await working.click()
  await expect(taskHeader(window).title).toHaveText(WORKING)
  await expect(regions(window).workspace).toContainText('Acme API')

  // The window stays hidden throughout, and so does the popover: an e2e run never shows either.
  const visible = await glade.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => w.isVisible()),
  )
  expect(visible).toEqual([false, false])
})

// #439: quitting closes every window before the menu bar is closed, and a change on its way then went to the popover's
// closed window. That threw from a timer, and Electron's dialog for an uncaught exception blocked main, and the quit,
// for good. Here the window closes while the app carries on, which took the same path.
test("the popover's window closing by itself leaves the menu bar working: a change after it isn't sent to it, and a click makes a new one", async ({
  launch,
}) => {
  const glade = await launch({ seed: seedPath('menu-bar.json') })
  const { window } = glade
  const page = await clickMenuBarIcon(glade)
  await expect(menuBarPopover(page).rows('Needs you')).toHaveCount(1)

  const closed = page.waitForEvent('close')
  await glade.app.evaluate(({ BrowserWindow }, route) => {
    for (const each of BrowserWindow.getAllWindows()) if (each.webContents.getURL().endsWith(route)) each.close()
  }, '#menu-bar')
  await closed
  await expect.poll(() => menuBarIcon(glade)).toMatchObject({ shown: true, open: false })

  // A change: opening the task that needs you reads its reply. The icon catches up, and main still answers.
  await chooseMenuItem(glade, 'Workspace', 'Switch workspace', 'Billing')
  await taskList(window).taskRow(NEEDS_YOU).click()
  await expect.poll(() => menuBarIcon(glade)).toMatchObject({ title: '' })
  await chooseMenuItem(glade, 'Task', 'Mark as unread')
  await expect.poll(() => menuBarIcon(glade)).toMatchObject({ title: '1' })

  // The next click makes a new window, showing what's in flight now.
  const reopened = await clickMenuBarIcon(glade)
  expect(reopened).not.toBe(page)
  await expect.poll(() => menuBarIcon(glade)).toMatchObject({ open: true })
  await expect(menuBarPopover(reopened).row('Needs you', NEEDS_YOU)).toBeVisible()
  await expect(menuBarPopover(reopened).rows('Working')).toHaveCount(1)
})

test('the popover says when nothing is in flight', async ({ launch }) => {
  const glade = await launch()
  await expect.poll(() => menuBarIcon(glade)).toMatchObject({ shown: true, title: '' })

  const popover = menuBarPopover(await clickMenuBarIcon(glade))
  await expect(popover.empty).toBeVisible()
  await expect(popover.dialog.getByRole('region')).toHaveCount(0)
  await expect(popover.openGlade).toBeVisible()
  await expect(popover.quit).toBeVisible()
})

test('Settings › General takes the icon out of the menu bar and puts it back, and a relaunch keeps it', async ({
  launch,
}) => {
  const glade = await launch({ seed: seedPath('menu-bar.json') })
  const modal = settings(glade.window)
  await expect.poll(() => menuBarIcon(glade)).toMatchObject({ shown: true })

  await chooseMenuItem(glade, 'Glade', 'Settings…')
  await modal.section('General').click()
  const toggle = modal.toggle('Show Glade in the menu bar')
  await expect(toggle).toBeChecked()

  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect.poll(() => menuBarIcon(glade)).toMatchObject({ shown: false })

  await toggle.click()
  await expect.poll(() => menuBarIcon(glade)).toMatchObject({ shown: true, title: '1' })

  // Off, it stays off after a relaunch.
  await toggle.click()
  await expect.poll(() => menuBarIcon(glade)).toMatchObject({ shown: false })
  await glade.close()
  const again = await launch()
  await expect.poll(() => menuBarIcon(again)).toMatchObject({ shown: false })
})
