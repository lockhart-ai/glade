import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test, type Glade, type LaunchOptions } from './fixtures'
import { chooseMenuItem } from './menu'
import { firstRun, inputBar, pauseBanner, settings, taskList, usageNote } from './selectors'

/** Starts a new task with `text`. */
async function startTask(window: Page, text: string): Promise<void> {
  await taskList(window).newTask.click()
  const bar = inputBar(window)
  await bar.field.fill(text)
  await bar.field.press('Enter')
}

/** Opens a workspace in a fresh app playing `agentScript`. */
async function openWorkspace(
  launch: (options?: LaunchOptions) => Promise<Glade>,
  tempFolder: () => string,
  agentScript: 'usage-warning' | 'usage-warning-resets' | 'usage-warning-then-limit',
): Promise<Glade> {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript, chosenFolder: root })
  await firstRun(glade.window).openFolder.click()
  return glade
}

test('Settings › General shows the account a task ran on, kept across a relaunch', async ({ launch, tempFolder }) => {
  const glade = await openWorkspace(launch, tempFolder, 'usage-warning')
  const modal = settings(glade.window)

  // Nothing is read until a task's session starts.
  await chooseMenuItem(glade, 'Glade', 'Settings…')
  await modal.section('General').click()
  await expect(modal.heading).toHaveText('General')
  await expect(modal.account).toContainText('Start a task to see it here.')
  await modal.close.click()

  await startTask(glade.window, 'Add rate limiting to the public API.')
  await chooseMenuItem(glade, 'Glade', 'Settings…')
  await modal.section('General').click()
  await expect(modal.account).toContainText('sam@acme.dev')
  await expect(modal.account).toContainText('Acme Robotics')
  await expect(modal.account).toContainText('Claude Max')
  await expect(modal.account).toContainText('Claude Code login')
  await expect(modal.account).toContainText(/Read from Claude Code at \d\d:\d\d, when a task last started\./)

  await glade.close()
  const relaunched = await launch()
  const again = settings(relaunched.window)
  await chooseMenuItem(relaunched, 'Glade', 'Settings…')
  await again.section('General').click()
  await expect(again.account).toContainText('sam@acme.dev')
})

test('a quiet note says the usage limit is close while tasks keep working, and goes when its window resets', async ({
  launch,
  tempFolder,
}) => {
  const { window } = await openWorkspace(launch, tempFolder, 'usage-warning-resets')
  await startTask(window, 'Add rate limiting to the public API.')

  const note = usageNote(window)
  await expect(note).toHaveText(/^You’ve used 85% of your session limit · resets \d\d:\d\d$/)
  await expect(note.getByRole('button')).toHaveCount(0)
  await expect(pauseBanner(window).banner).toHaveCount(0)
  // The task isn't held up.
  await expect(taskList(window).rows('Active').first()).toContainText('Add rate limiting to public API')

  // The window resets a few seconds later: the note goes on its own.
  await expect(note).toHaveCount(0, { timeout: 15_000 })
})

test('the paused tasks’ banner takes the note’s place once the limit runs out: never both', async ({
  launch,
  tempFolder,
}) => {
  const { window } = await openWorkspace(launch, tempFolder, 'usage-warning-then-limit')
  await startTask(window, 'Add rate limiting to the public API.')
  const note = usageNote(window)
  await expect(note).toContainText('You’ve used 85% of your session limit')

  const bar = inputBar(window)
  await bar.field.fill('Apply it to the viewsets.')
  await bar.field.press('Enter')

  const { banner } = pauseBanner(window)
  await expect(banner).toContainText('Usage limit reached.')
  await expect(note).toHaveCount(0)
  await expect(window.getByRole('status', { name: /^(Paused tasks|Usage warning)$/ })).toHaveCount(1)
})
