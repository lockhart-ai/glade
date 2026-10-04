import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import {
  chooseFolder,
  expect,
  focusWindow,
  setExtraUsage,
  setOnline,
  test,
  type Glade,
  type LaunchOptions,
} from './fixtures'
import { chooseMenuItem } from './menu'
import {
  chat,
  firstRun,
  inputBar,
  pauseBanner,
  regions,
  taskHeader,
  taskList,
  usageMeter,
  workspaceSwitcher,
} from './selectors'

/** What the scripts' copy ends with once it resumes. */
const FINISHED = 'The copy finished: all 3,900 files are in the bucket.'

/** An element's background colour, as the browser computes it. */
function backgroundOf(locator: Locator): Promise<string> {
  return locator.evaluate((element) => getComputedStyle(element).backgroundColor)
}

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
  agentScript: 'usage-limit' | 'usage-limit-hour' | 'usage-limit-extra' | 'offline',
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
    /^Usage limit reached\. 2 tasks are paused and will resume on their own at \d\d:\d\d\.\s*Resume now\s*Switch model\s*Details$/,
  )
  const rows = taskList(window).rows('Active')
  await expect(rows).toHaveCount(2)
  for (const row of await rows.all()) {
    await expect(row).toContainText(/Paused: usage limit · resumes \d\d:\d\d/)
    await expect(taskList(window).dot(row)).toHaveAttribute('data-state', 'working')
  }

  // The selected task says so in its header, chat and input bar, with no error card.
  const { pausedLine, errorCard, agentReplies } = chat(window)
  await expect(taskHeader(window).stateDot).toHaveAccessibleName('Active · paused')
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
  await expect(taskHeader(window).stateDot).toHaveAccessibleName('Active · idle')
})

test('Switch model moves the paused tasks to another model and resumes them now', async ({ launch, tempFolder }) => {
  const { window } = await openWorkspace(launch, tempFolder, 'usage-limit-hour')
  await startTask(window, 'Move the existing uploads to S3.')
  const { banner, switchModel } = pauseBanner(window)
  await expect(banner).toContainText('1 task is paused and will resume on its own at')
  const bar = inputBar(window)
  // The session has reported the SDK's models: the task's Opus 5.5 is its default.
  await expect(bar.setting('Model')).toHaveAccessibleName('Model: Default (recommended)')

  await switchModel.click()
  await window.getByRole('menuitemradio', { name: 'Sonnet', exact: true }).click()

  await expect(banner).toHaveCount(0)
  await expect(chat(window).agentReplies).toContainText([FINISHED])
  await expect(bar.setting('Model')).toHaveAccessibleName('Model: Sonnet')
})

test('Resume now resumes the paused tasks of every workspace at once; one still over the limit pauses again', async ({
  launch,
  tempFolder,
}) => {
  const UPLOADS = 'Move the existing uploads to S3.'
  const THUMBNAILS = 'Move the thumbnails to S3 too.'
  const rootA = join(tempFolder(), 'acme-api')
  const rootB = join(tempFolder(), 'acme-storefront')
  mkdirSync(rootA)
  mkdirSync(rootB)
  // The uploads' account is still over its limit the first time the task is resumed; the thumbnails' isn't.
  const glade = await launch({
    agentScriptsByFirstMessage: { [UPLOADS]: 'usage-limit-twice', [THUMBNAILS]: 'usage-limit-hour' },
    chosenFolder: rootA,
  })
  const { window } = glade
  const { banner, resumeNow, switchModel } = pauseBanner(window)
  const { pausedLine, errorCard, agentReplies } = chat(window)
  const switcher = workspaceSwitcher(window)
  const workspace = regions(window).workspace

  // A task paused in each of two workspaces, behind the one banner.
  await firstRun(window).openFolder.click()
  await startTask(window, UPLOADS)
  await expect(banner).toContainText('1 task is paused')
  await chooseFolder(glade, rootB)
  await chooseMenuItem(glade, 'Workspace', 'New workspace…')
  await expect(workspace).toContainText('acme-storefront')
  await startTask(window, THUMBNAILS)
  await expect(banner).toHaveText(
    /^Usage limit reached\. 2 tasks are paused and will resume on their own at \d\d:\d\d\.\s*Resume now\s*Switch model\s*Details$/,
  )
  // Resume now sits beside Switch model, a secondary button like it.
  await expect(resumeNow).toHaveCSS('background-color', await backgroundOf(switchModel))

  await resumeNow.click()

  // The thumbnails' task, in the workspace shown, carries on and finishes on its own model.
  await expect(agentReplies).toContainText([FINISHED])
  await expect(inputBar(window).setting('Model')).toHaveAccessibleName('Model: Default (recommended)')
  // The uploads' task, in the other workspace, was resumed too, and turned away again: the banner is back for it alone.
  await expect(banner).toContainText('Usage limit reached. 1 task is paused and will resume on its own at')
  await switcher.trigger.click()
  await switcher.row('acme-api').click()
  await expect(workspace).toContainText('acme-api')
  await taskList(window).rows('Active').first().click()
  await expect(pausedLine).toHaveText(/^Paused · resumes at \d\d:\d\d$/)
  await expect(errorCard).toHaveCount(0)
  await expect(taskList(window).rows('Active').first()).toContainText(/Paused: usage limit · resumes \d\d:\d\d/)

  // Pressed again, once the limit has gone, it finishes too, and the banner goes.
  await resumeNow.click()
  await expect(banner).toHaveCount(0)
  await expect(agentReplies).toContainText([FINISHED])
  await expect(errorCard).toHaveCount(0)
})

test('tasks paused on a usage limit resume by themselves once extra usage is turned on, and the meter shows it', async ({
  launch,
  tempFolder,
}) => {
  const glade = await openWorkspace(launch, tempFolder, 'usage-limit-extra')
  const { window } = glade
  await startTask(window, 'Move the existing uploads to S3.')
  const { banner } = pauseBanner(window)
  const meter = usageMeter(window)
  await expect(banner).toContainText('1 task is paused and will resume on its own at')
  // The limit resets in an hour: nothing resumes the task before then by itself, with extra usage off.
  await expect(meter.row).toHaveText(/^Session limit\s*Resets at (\w{3} \d{1,2} )?\d\d:\d\d$/)
  await meter.row.click()
  await expect(meter.limits).toHaveText([/^Session\s*100%/, /^This week\s*64%/])
  await window.keyboard.press('Escape')

  // You turn extra usage on in the browser, and come back to Glade: it reads usage again, and resumes the task.
  await setExtraUsage(glade, true)
  await focusWindow(glade)

  await expect(banner).toHaveCount(0)
  await expect(chat(window).agentReplies).toContainText([FINISHED])
  await expect(chat(window).errorCard).toHaveCount(0)
  // The account now runs on extra usage: the meter's line says so, with the money spent of its cap (#530), in place of
  // the limit that ran out, and its row in the list says the same.
  await expect(meter.row).toHaveText(/^Extra usage\s*\$0\.00\s*of \$50\.00$/)
  await expect(meter.row).toHaveAttribute('data-state', 'extra_usage')
  await meter.row.click()
  await expect(meter.limits).toHaveText([/^Session\s*100%/, /^This week\s*64%/, /^Extra usage\s*\$0\.00 of \$50\.00$/])
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
  await expect(taskHeader(window).stateDot).toHaveAccessibleName('Active · idle')
})
