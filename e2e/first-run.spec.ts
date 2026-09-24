import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chooseFolder, expect, test } from './fixtures'
import { firstRun, regions } from './selectors'

test('first run: choose a folder, and it opens as an empty workspace', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch()
  const { welcome, workspace, task } = regions(glade.window)
  const { openFolder } = firstRun(glade.window)

  // Cancelling the folder dialog leaves the welcome up.
  await openFolder.click()
  await expect(welcome).toBeVisible()
  await expect(workspace).toContainText('No workspace')

  await chooseFolder(glade, root)
  await openFolder.click()

  await expect(welcome).toHaveCount(0)
  await expect(task).toBeVisible()
  await expect(workspace).toContainText('acme-api')
  expect(existsSync(join(root, 'CLAUDE.md'))).toBe(true)

  // Relaunched on the same data, it opens straight into the workspace.
  await glade.close()
  const relaunched = await launch()
  await expect(regions(relaunched.window).task).toBeVisible()
  await expect(regions(relaunched.window).workspace).toContainText('acme-api')
})
