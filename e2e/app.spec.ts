import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname } from 'node:path'
import { expect, test } from './fixtures'
import { regions } from './selectors'

test('launches, hydrated, to the first-run screen', async ({ launch }) => {
  const { app, window } = await launch()

  const { sidebar, workspace, welcome, terminal, task } = regions(window)
  for (const region of [sidebar, workspace, welcome, terminal]) await expect(region).toBeVisible()
  await expect(workspace).toContainText('No workspace')
  await expect(task).toHaveCount(0)
  await expect(window.getByText('Loading…')).toHaveCount(0)

  // The window is never shown on screen, but it's the size the recordings are.
  const shown = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))
  expect(shown).toEqual([false])
  expect(await window.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight])).toEqual([1920, 1200])
})

test('keeps its data in a throwaway folder', async ({ launch }) => {
  const { app } = await launch()

  const userData = await app.evaluate(({ app }) => app.getPath('userData'))
  expect(dirname(userData)).toBe(tmpdir())
  expect(basename(userData)).toMatch(/^glade-e2e-data-/)
  expect(readdirSync(userData)).toContain('glade.db')
})
