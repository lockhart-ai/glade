import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test, type Glade, type LaunchOptions } from './fixtures'
import { chooseMenuItem } from './menu'
import { firstRun, inputBar, pauseBanner, settings, taskList, usageMeter } from './selectors'

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
  agentScript: 'usage-warning' | 'usage-warning-resets' | 'usage-meter' | 'usage-limit-hour',
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

test('the usage meter reads the usage call once a turn ends, lists every limit, and keeps them across a relaunch', async ({
  launch,
  tempFolder,
}) => {
  const glade = await openWorkspace(launch, tempFolder, 'usage-meter')
  const meter = usageMeter(glade.window)

  // Nothing read yet: an empty ring, within limits.
  await expect(meter.row).toHaveText(/^Usage\s*within limits$/)
  await expect(meter.row).toHaveAttribute('data-state', 'unknown')

  // The call answers once the first turn ends: as the session starts, the script isn't picked yet, and it rejects.
  await startTask(glade.window, 'Add rate limiting to the public API.')
  await expect(meter.row).toHaveText(/^Session\s*38%\s*resets (\w{3} \d{1,2} )?\d\d:\d\d$/)
  await expect(meter.row).toHaveAttribute('data-state', 'normal')

  await meter.row.click()
  await expect(meter.popover).toContainText('Claude Max')
  await expect(meter.limits).toHaveText([
    /^Session\s*38%\s*resets (\w{3} \d{1,2} )?\d\d:\d\d$/,
    /^This week\s*22%\s*resets \w{3} \d{1,2} \d\d:\d\d$/,
    /^This week · Opus\s*9%\s*resets \w{3} \d{1,2} \d\d:\d\d$/,
  ])
  await expect(meter.popover).toContainText(/From Claude Code · updated just now$/)
  await glade.window.keyboard.press('Escape')
  await expect(meter.popover).toHaveCount(0)

  await glade.close()
  const relaunched = await launch()
  await expect(usageMeter(relaunched.window).row).toHaveText(/^Session\s*38%\s*resets (\w{3} \d{1,2} )?\d\d:\d\d$/)
})

test('the meter turns purple from the rate limit events while tasks keep working, with no note up top', async ({
  launch,
  tempFolder,
}) => {
  const { window } = await openWorkspace(launch, tempFolder, 'usage-warning-resets')
  await startTask(window, 'Add rate limiting to the public API.')

  // This script's SDK has no usage call: the meter reads the events alone.
  const meter = usageMeter(window)
  await expect(meter.row).toHaveText(/^Session\s*85%\s*resets (\w{3} \d{1,2} )?\d\d:\d\d$/)
  await expect(meter.row).toHaveAttribute('data-state', 'warning')
  await expect(window.getByRole('status', { name: 'Usage warning' })).toHaveCount(0)
  await expect(pauseBanner(window).banner).toHaveCount(0)
  // The task isn't held up.
  await expect(taskList(window).rows('Active').first()).toContainText('Add rate limiting to public API')

  // The window resets a few seconds later: the reading goes on its own.
  await expect(meter.row).toHaveText(/^Usage\s*within limits$/, { timeout: 15_000 })
})

test('at the limit the meter says when it resets, and the paused tasks’ banner still shows', async ({
  launch,
  tempFolder,
}) => {
  const { window } = await openWorkspace(launch, tempFolder, 'usage-limit-hour')
  await startTask(window, 'Move the image uploads to S3.')

  const meter = usageMeter(window)
  await expect(meter.row).toHaveText(/^Session limit\s*Resets at (\w{3} \d{1,2} )?\d\d:\d\d$/)
  await expect(meter.row).toHaveAttribute('data-state', 'limited')
  await expect(pauseBanner(window).banner).toContainText('Usage limit reached.')

  await meter.row.click()
  await expect(meter.limits).toHaveText([/^Session\s*limit reached\s*resets (\w{3} \d{1,2} )?\d\d:\d\d$/])
})
