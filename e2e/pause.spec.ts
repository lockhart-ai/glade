import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, setOnline, test, type Glade, type LaunchOptions } from './fixtures'
import { chat, firstRun, inputBar, pauseBanner, taskHeader, taskList } from './selectors'

/** What the scripts' copy ends with once it resumes. */
const FINISHED = 'The copy finished: all 3,900 files are in the bucket.'

/** Starts a new task with `text`, which its script's first turn pauses. */
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
  agentScript: 'usage-limit' | 'usage-limit-hour' | 'offline',
): Promise<Glade> {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript, chosenFolder: root })
  await firstRun(glade.window).openFolder.click()
  return glade
}

test('a usage limit pauses tasks behind one banner, and they resume on their own when it resets', async ({
  launch,
  tempFolder,
}) => {
  const { window } = await openWorkspace(launch, tempFolder, 'usage-limit')
  await startTask(window, 'Move the existing uploads to S3.')
  await startTask(window, 'Move the thumbnails to S3 too.')

  // One banner for both, not an error card each.
  const { banner, details, pausedTasks, said } = pauseBanner(window)
  await expect(banner).toHaveText(
    /^Usage limit reached\. 2 tasks are paused and will resume on their own at \d\d:\d\d\.\s*Switch model\s*Details$/,
  )
  const rows = taskList(window).rows('Active')
  await expect(rows).toHaveCount(2)
  for (const row of await rows.all()) {
    await expect(row).toContainText(/Paused: usage limit · resumes \d\d:\d\d/)
    await expect(taskList(window).dot(row)).toHaveAttribute('data-state', 'working')
  }

  // The selected task says so in its header, chat and input bar, with no error card.
  const { pausedLine, errorCard, agentReplies } = chat(window)
  await expect(taskHeader(window).pill).toHaveText('Active · paused')
  await expect(pausedLine).toHaveText(/^Paused · resumes at \d\d:\d\d$/)
  await expect(errorCard).toHaveCount(0)
  const bar = inputBar(window)
  await expect(bar.field).toHaveAttribute('placeholder', 'Messages are queued until the task resumes…')
  await expect(bar.stop).toHaveCount(0)

  // Details lists the paused tasks and what the API said.
  await details.click()
  await expect(pausedTasks).toHaveCount(2)
  await expect(said).toHaveText("You've hit your session limit · resets 11:42am")

  // A message sent meanwhile waits in the queue until the task resumes.
  await bar.field.fill('Keep the original filenames.')
  await bar.field.press('Enter')
  await expect(bar.queued).toContainText('Sent when the task resumes')

  // The limit resets: both tasks resume on their own, finish the copy, and the banner goes.
  await expect(banner).toHaveCount(0)
  await expect(pausedLine).toHaveCount(0)
  await expect(agentReplies.first()).toContainText(FINISHED)
  await expect(bar.queued).toHaveCount(0)
  await expect(chat(window).userMessages.last()).toHaveText(/Keep the original filenames\./)
  for (const row of await rows.all()) await expect(row).toContainText('All 3,900 files copied to S3.')
  await expect(taskHeader(window).pill).toHaveText('Active · waiting on you')
})

test('Switch model moves the paused tasks to another model and resumes them now', async ({ launch, tempFolder }) => {
  const { window } = await openWorkspace(launch, tempFolder, 'usage-limit-hour')
  await startTask(window, 'Move the existing uploads to S3.')
  const { banner, switchModel } = pauseBanner(window)
  await expect(banner).toContainText('1 task is paused and will resume on its own at')
  const bar = inputBar(window)
  await expect(bar.setting('Model')).toHaveAccessibleName('Model: Opus 5.5')

  await switchModel.click()
  await window.getByRole('menuitemradio', { name: 'Sonnet 5', exact: true }).click()

  await expect(banner).toHaveCount(0)
  await expect(chat(window).agentReplies).toContainText([FINISHED])
  await expect(bar.setting('Model')).toHaveAccessibleName('Model: Sonnet 5')
})

test('losing the network pauses the task, and it resumes on its own once the network is back', async ({
  launch,
  tempFolder,
}) => {
  const glade = await openWorkspace(launch, tempFolder, 'offline')
  const { window } = glade
  await setOnline(glade, false)
  await startTask(window, 'Move the existing uploads to S3.')

  const { banner, switchModel, details, said } = pauseBanner(window)
  await expect(banner).toHaveText(
    /^Can’t reach the API\. 1 task is paused and will resume on its own when the network is back\.\s*Details$/,
  )
  await expect(switchModel).toHaveCount(0)
  await expect(taskList(window).rows('Active').first()).toContainText('Paused: offline')
  await expect(chat(window).pausedLine).toHaveText('Paused · resumes when the network is back')
  await details.click()
  await expect(said).toHaveText('API Error: Connection error.')

  await setOnline(glade, true)

  // Glade checks for the network 5 seconds after it went, then 10 seconds after that.
  await expect(banner).toHaveCount(0, { timeout: 30_000 })
  await expect(chat(window).agentReplies).toContainText([FINISHED])
  await expect(taskHeader(window).pill).toHaveText('Active · waiting on you')
})
