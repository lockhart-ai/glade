import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chooseFolder, expect, test } from './fixtures'
import { chooseMenuItem, findMenuItem, menuItem } from './menu'
import { chat, firstRun, inputBar, regions, removeWorkspaceDialog, taskHeader, taskList, toasts } from './selectors'

test('menu bar: its Workspace menu, switching workspaces, Mark done, Toggle task list, and closing and removing a workspace', async ({
  launch,
  tempFolder,
}) => {
  const parent = tempFolder()
  const rootA = join(parent, 'acme-api')
  const rootB = join(parent, 'acme-web')
  mkdirSync(rootA)
  mkdirSync(rootB)
  const glade = await launch({ agentScript: 'multi-tool-turn', chosenFolder: rootA })
  const { window } = glade
  const workspace = regions(window).workspace
  const header = taskHeader(window)
  const list = taskList(window)

  // Before there's a workspace, the Workspace and Task menus have nothing to act on but adding one.
  await expect(firstRun(window).openFolder).toBeVisible()
  expect(await menuItem(glade, 'Workspace', 'Switch workspace')).toMatchObject({ enabled: false })
  expect(await menuItem(glade, 'Workspace', 'Close workspace')).toMatchObject({ enabled: false })
  expect(await menuItem(glade, 'Task', 'Mark done')).toMatchObject({ enabled: false })

  // Workspace › Open folder as workspace… (⌘O) opens A; New workspace… (⌘⇧N) adds B and shows it.
  await chooseMenuItem(glade, 'Workspace', 'Open folder as workspace…')
  await expect(workspace).toContainText('acme-api')
  await chooseFolder(glade, rootB)
  await chooseMenuItem(glade, 'Workspace', 'New workspace…')
  await expect(workspace).toContainText('acme-web')

  // Switch workspace lists both, oldest first, with ⌘1 and ⌘2 and a check on the one shown; choosing A shows it.
  await expect
    .poll(async () => [
      await menuItem(glade, 'Workspace', 'Switch workspace', 'acme-api'),
      await menuItem(glade, 'Workspace', 'Switch workspace', 'acme-web'),
    ])
    .toEqual([
      { label: 'acme-api', enabled: true, checked: false, accelerator: 'CmdOrCtrl+1' },
      { label: 'acme-web', enabled: true, checked: true, accelerator: 'CmdOrCtrl+2' },
    ])
  await chooseMenuItem(glade, 'Workspace', 'Switch workspace', 'acme-api')
  await expect(workspace).toContainText('acme-api')
  await expect.poll(async () => (await menuItem(glade, 'Workspace', 'Switch workspace', 'acme-api')).checked).toBe(true)

  // A task, set up by its agent: Task › Mark done (⌘⇧D) marks it done, with the toast's Undo.
  await chooseMenuItem(glade, 'File', 'New task')
  await inputBar(window).field.fill('The date test is flaky. Can you fix it?')
  await inputBar(window).field.press('Enter')
  await expect(chat(window).agentReplies).toHaveCount(1)
  await chooseMenuItem(glade, 'Task', 'Mark done')
  await expect(toasts(window).region).toContainText('Marked done.')
  await expect(header.stateDot).toHaveAccessibleName(/^Done · /)
  await expect(list.rows('Done')).toHaveCount(1)
  // Now it's done, the Task menu offers Reopen instead.
  await expect.poll(async () => (await menuItem(glade, 'Task', 'Mark done')).enabled).toBe(false)
  expect(await menuItem(glade, 'Task', 'Reopen')).toMatchObject({ enabled: true })

  // View › Toggle task list (⌘B) collapses the task list and shows it again. The key itself is the menu bar's: the
  // page leaves it alone, so it never toggles twice.
  await chooseMenuItem(glade, 'View', 'Toggle task list')
  await expect(regions(window).sidebar).toHaveCount(0)
  await window.keyboard.press('Meta+KeyB')
  await expect(regions(window).sidebar).toHaveCount(0)
  await chooseMenuItem(glade, 'View', 'Toggle task list')
  await expect(regions(window).sidebar).toBeVisible()

  // Workspace › Close workspace (⌘⇧W) shows B, the other one; A stays in the list.
  await chooseMenuItem(glade, 'Workspace', 'Close workspace')
  await expect(workspace).toContainText('acme-web')
  expect(await menuItem(glade, 'Workspace', 'Switch workspace', 'acme-api')).toMatchObject({ checked: false })

  // Remove from list… asks first: Cancel keeps B; Remove forgets it, leaving its folder, and shows A.
  const remove = removeWorkspaceDialog(window)
  await chooseMenuItem(glade, 'Workspace', 'Remove from list…')
  await expect(remove.dialog).toHaveAccessibleName('Remove “acme-web” from the list?')
  await remove.cancel.click()
  await expect(remove.dialog).toHaveCount(0)
  await expect(workspace).toContainText('acme-web')
  await chooseMenuItem(glade, 'Workspace', 'Remove from list…')
  await remove.confirm.click()
  await expect(workspace).toContainText('acme-api')
  await expect(list.rows('Done')).toHaveCount(1)
  expect(existsSync(rootB)).toBe(true)
  await expect.poll(() => findMenuItem(glade, ['Workspace', 'Switch workspace', 'acme-web'])).toBeNull()

  // Closing the only workspace goes to the first-run window, and it's still there after a relaunch; the menu bar
  // brings the workspace back.
  await chooseMenuItem(glade, 'Workspace', 'Close workspace')
  await expect(firstRun(window).openFolder).toBeVisible()
  await glade.close()
  const relaunched = await launch()
  await expect(firstRun(relaunched.window).openFolder).toBeVisible()
  await chooseMenuItem(relaunched, 'Workspace', 'Switch workspace', 'acme-api')
  await expect(regions(relaunched.window).workspace).toContainText('acme-api')
  await expect(taskHeader(relaunched.window).stateDot).toHaveAccessibleName(/^Done · /)
})
