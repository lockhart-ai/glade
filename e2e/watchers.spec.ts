import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { WATCHES_THINGS } from '../src/main/agent/scripts'
import { expect, test, type Glade, type LaunchOptions } from './fixtures'
import { chat, firstRun, inputBar, taskHeader, taskList, taskPanel, watchersTab, watchingMark } from './selectors'

/**
 * A task whose agent leaves one of each watcher (the `watches-things` script): a Monitor on PR #42's CI, the
 * integration tests and the docs build in the background, a wakeup to check the rollout and a cron job on the staging
 * queue. Waits for the four wakes they bring, then shows the Watchers tab (⌘⌥6).
 */
async function watchThings(launch: (options: LaunchOptions) => Promise<Glade>, root: string): Promise<Page> {
  const { window } = await launch({ agentScript: 'watches-things', chosenFolder: root })
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const bar = inputBar(window)
  await bar.field.fill(WATCHES_THINGS.prompt)
  await bar.field.press('Enter')
  // Its first reply, then one for each wake: a failed check, the docs build failing, the job firing and a passing check.
  await expect(chat(window).agentReplies).toHaveCount(5)
  await expect(chat(window).agentReplies.last()).toContainText(WATCHES_THINGS.lintPassed)
  await window.keyboard.press('Meta+Alt+Digit6')
  await expect(taskPanel(window).tab(/^Watch/)).toHaveAttribute('aria-selected', 'true')
  return window
}

test('watchers: each thing the agent left running or scheduled, with its state, wakes and last line, counted on the tab and the task list', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const window = await watchThings(launch, root)
  const watchers = watchersTab(window)

  await expect(taskPanel(window).tab(/^Watch/)).toHaveText('Watchers 4')
  await expect(watchers.tally).toHaveText('2 running2 scheduled1 ended')
  // The live ones first, in the order the agent started them, then the one that ended.
  expect(await watchers.rows.evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label')))).toEqual([
    WATCHES_THINGS.ci,
    WATCHES_THINGS.tests,
    WATCHES_THINGS.rollout,
    WATCHES_THINGS.queue,
    WATCHES_THINGS.docs,
  ])

  const ci = watchers.row(WATCHES_THINGS.ci)
  await expect(ci).toHaveAttribute('data-state', 'running')
  await expect(ci).toContainText('Running')
  await expect(ci).toContainText(`Monitor${WATCHES_THINGS.ciCommand}`)
  // What it last reported, and each event that woke the agent.
  await expect(ci).toContainText('lastlint pass 41s')
  await expect(ci).toContainText('2 wakes · last')
  await expect(watchers.row(WATCHES_THINGS.tests)).toContainText(`RunningStopCommand${WATCHES_THINGS.testsCommand}`)
  await expect(watchers.row(WATCHES_THINGS.tests)).toContainText('0 wakes')
  const rollout = watchers.row(WATCHES_THINGS.rollout)
  await expect(rollout).toHaveAttribute('data-state', 'scheduled')
  await expect(rollout).toContainText(/Due in [56]mStopWakeup/)
  await expect(rollout).toContainText(WATCHES_THINGS.rolloutPrompt)
  const queue = watchers.row(WATCHES_THINGS.queue)
  await expect(queue).toContainText(/Due in \d+[sm]StopCron/)
  await expect(queue).toContainText(WATCHES_THINGS.queueSchedule)
  await expect(queue).toContainText(/1 wake · last \d\d:\d\d · next/)
  const docs = watchers.row(WATCHES_THINGS.docs)
  await expect(docs).toHaveAttribute('data-state', 'failed')
  await expect(docs).toContainText(`FailedCommand${WATCHES_THINGS.docsCommand}end${WATCHES_THINGS.docsFailed}`)
  await expect(docs.getByRole('button')).toHaveCount(0)

  // The task list marks the task as still watching things while it waits on you.
  const row = taskList(window).taskRow(WATCHES_THINGS.title)
  await expect(watchingMark(row)).toHaveAccessibleName('4 watchers running')
  await expect(taskList(window).dot(row)).toHaveAttribute('data-state', 'waiting')

  // Marked done, it's still watching them: the Done row keeps the mark, and the tab its watchers.
  await taskHeader(window).markDone.click()
  const done = taskList(window).row('Done', WATCHES_THINGS.title)
  await expect(watchingMark(done)).toHaveAccessibleName('4 watchers running')
  await expect(taskPanel(window).tab(/^Watch/)).toHaveText('Watchers 4')
  await expect(watchers.stop(WATCHES_THINGS.ci)).toBeVisible()
})

test('watchers: Stop stops each kind, the SDK’s way where it has one, and the counts follow', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const window = await watchThings(launch, root)
  const watchers = watchersTab(window)
  const tab = taskPanel(window).tab(/^Watch/)
  const mark = watchingMark(taskList(window).taskRow(WATCHES_THINGS.title))

  // The monitor and the command: their processes are stopped, and they end when the SDK says so.
  await watchers.stop(WATCHES_THINGS.ci).click()
  await expect(watchers.row(WATCHES_THINGS.ci)).toHaveAttribute('data-state', 'stopped')
  await expect(watchers.row(WATCHES_THINGS.ci)).toContainText('endYou stopped it.')
  await expect(tab).toHaveText('Watchers 3')
  await watchers.stop(WATCHES_THINGS.tests).click()
  await expect(watchers.row(WATCHES_THINGS.tests)).toHaveAttribute('data-state', 'stopped')
  await expect(mark).toHaveAccessibleName('2 watchers running')

  // The wakeup and the cron job stop at once: only the agent could delete them, so their fires are turned away.
  await watchers.stop(WATCHES_THINGS.rollout).click()
  await expect(watchers.row(WATCHES_THINGS.rollout)).toHaveAttribute('data-state', 'stopped')
  await watchers.stop(WATCHES_THINGS.queue).click()
  await expect(watchers.row(WATCHES_THINGS.queue)).toHaveAttribute('data-state', 'stopped')
  await expect(watchers.row(WATCHES_THINGS.queue)).toContainText('1 wake')

  await expect(tab).toHaveText('Watchers')
  await expect(watchers.tally).toHaveText('5 ended')
  await expect(watchers.rows.getByRole('button')).toHaveCount(0)
  await expect(mark).toHaveCount(0)
  // Stopping them never woke the agent.
  await expect(chat(window).agentReplies).toHaveCount(5)
})

test('watchers: a relaunch stops what died with the session, and the cron job comes back when the session resumes', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const first = await launch({ agentScript: 'watches-things', chosenFolder: root })
  await firstRun(first.window).openFolder.click()
  await taskList(first.window).newTask.click()
  const firstBar = inputBar(first.window)
  await firstBar.field.fill(WATCHES_THINGS.prompt)
  await firstBar.field.press('Enter')
  await expect(chat(first.window).agentReplies).toHaveCount(5)
  await first.kill()

  const { window } = await launch({ agentScript: 'still-watching' })
  await expect(chat(window).agentReplies).toHaveCount(5)
  await window.keyboard.press('Meta+Alt+Digit6')
  const watchers = watchersTab(window)
  for (const name of [WATCHES_THINGS.ci, WATCHES_THINGS.tests, WATCHES_THINGS.rollout]) {
    await expect(watchers.row(name)).toHaveAttribute('data-state', 'stopped')
    await expect(watchers.row(name)).toContainText('endStopped by the relaunch.')
  }
  // The cron job waits for the session: the SDK brings it back when the session resumes.
  const queue = watchers.row(WATCHES_THINGS.queue)
  await expect(queue).toHaveAttribute('data-state', 'suspended')
  await expect(queue).toContainText('back when the session resumes')
  await expect(taskPanel(window).tab(/^Watch/)).toHaveText('Watchers 1')
  await expect(watchingMark(taskList(window).taskRow(WATCHES_THINGS.title))).toHaveAccessibleName('1 watcher running')

  const bar = inputBar(window)
  await bar.field.fill('How is it going?')
  await bar.field.press('Enter')
  await expect(chat(window).agentReplies.last()).toContainText(WATCHES_THINGS.again)
  await expect(queue).toHaveAttribute('data-state', 'scheduled')
  await expect(queue).toContainText(/Due in \d+[sm]/)
  await expect(watchers.tally).toHaveText('1 scheduled4 ended')
})
