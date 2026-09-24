import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { CommandName } from '../src/shared/bridge'
import { TaskActivity, type Task } from '../src/shared/domain'
import { expect, test } from './fixtures'
import { chat, firstRun, inputBar, relaunchNotice, taskHeader, taskList, taskPanel } from './selectors'
import { invoke } from './task-view'

/** The only task in the only workspace, as main has it. */
async function onlyTask(window: Page): Promise<Task | undefined> {
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const { tasks } = await invoke(window, CommandName.TasksList, { workspaceId: workspaces[0]?.id ?? '' })
  return tasks[0]
}

test('force-quit mid-turn, relaunch: the task resumes its session and finishes the turn', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const first = await launch({ agentScript: 'long-running', chosenFolder: root })
  await firstRun(first.window).openFolder.click()
  await taskList(first.window).newTask.click()

  const bar = inputBar(first.window)
  await bar.field.fill('Run the e2e suite.')
  await bar.field.press('Enter')
  await expect(taskPanel(first.window).call(/^Running\s*Bash/)).toBeVisible()
  await expect.poll(async () => (await onlyTask(first.window))?.activity).toBe(TaskActivity.Working)
  const { id: taskId, sessionId } = (await onlyTask(first.window)) ?? {}
  expect(sessionId).toBeTruthy()

  // Force-quit in the middle of the turn: nothing runs on the way out.
  await first.kill()
  const killedAt = Date.now()

  // On relaunch the task is still selected, and its turn carries on in the same session.
  const { window } = await launch({ agentScript: 'long-running' })
  const { userMessages, agentReplies, restarts } = chat(window)
  await expect(userMessages).toHaveCount(1)
  await expect(userMessages.first()).toContainText('Run the e2e suite.')
  await expect(restarts).toHaveCount(1)
  await expect(restarts.first()).toHaveText(/^Glade restarted · \d\d:\d\d/)
  await expect(agentReplies).toHaveCount(1)
  await expect(agentReplies.first()).toContainText('The end-to-end suite passes: all 41 tests.')
  await expect(restarts.first()).toHaveText(/^Glade restarted · \d\d:\d\d$/)

  // The turn's summary times all of it, from your message to the reply, not just the part after the relaunch.
  const { messages } = await invoke(window, CommandName.TasksHistory, { id: taskId ?? '' })
  const [sent, reply] = messages
  const durationMs = reply?.summary?.durationMs ?? 0
  expect(durationMs).toBe((reply?.createdAt ?? 0) - (sent?.createdAt ?? 0))
  expect(durationMs).toBeGreaterThanOrEqual(killedAt - (sent?.createdAt ?? 0))
  expect(durationMs).toBeLessThan(60_000)
  await expect(chat(window).turnSummaries).toHaveText(`Finished in ${String(Math.round(durationMs / 1000))}s`)

  // The tool log keeps what the first run did: the command the quit cut off failed, then the turn resumed.
  const panel = taskPanel(window)
  await expect(panel.call(/^Failed\s*Bash/)).toBeVisible()
  await expect(panel.dividers.filter({ hasText: /^resumed after restart/ })).toHaveCount(1)
  await expect(panel.call(/^Done\s*Bash/)).toBeVisible()
  await expect(panel.log).toContainText('Glade restarted mid-run, so I am running the suite again.')

  await expect.poll(async () => (await onlyTask(window))?.activity).toBe(TaskActivity.Waiting)
  expect((await onlyTask(window))?.sessionId).toBe(sessionId)
  await expect(taskList(window).rows('Active').first()).toContainText('The e2e suite passes.')
  await expect(relaunchNotice(window).notice).toContainText(
    'Everything was saved. 1 task was mid-turn and has picked up where it left off.',
  )
})

/** Each task's first message, which picks the long-running script it plays. */
const RUN_SUITE = 'Run the e2e suite.'
const COPY_UPLOADS = 'Move image uploads to S3.'
const BUILD_RELEASE = 'Build the release.'
const SCRIPTS = {
  [RUN_SUITE]: 'long-running',
  [COPY_UPLOADS]: 'copy-in-batches',
  [BUILD_RELEASE]: 'long-build',
} as const

/** Every task in the only workspace, as main has it. */
async function allTasks(window: Page): Promise<readonly Task[]> {
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  return (await invoke(window, CommandName.TasksList, { workspaceId: workspaces[0]?.id ?? '' })).tasks
}

test('kill -9 during several running tasks: relaunch resumes all of them, delivers the queue, and says so', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const first = await launch({ agentScriptsByFirstMessage: SCRIPTS, chosenFolder: root })
  await firstRun(first.window).openFolder.click()
  const list = taskList(first.window)
  const bar = inputBar(first.window)
  const panel = taskPanel(first.window)

  // Three tasks, each left working with a command running.
  for (const message of [RUN_SUITE, COPY_UPLOADS, BUILD_RELEASE]) {
    await list.newTask.click()
    await bar.field.fill(message)
    await bar.field.press('Enter')
    await expect(panel.call(/^Running\s*Bash/)).toBeVisible()
  }
  await expect(list.rows('Active')).toHaveCount(3)

  // A message queued on the copy, waiting for its command to finish.
  await list.row('Active', 'Move image uploads to S3').click()
  await expect(panel.call(/^Running\s*Bash/)).toBeVisible()
  await bar.field.fill('Keep the original filenames in the bucket keys.')
  await bar.field.press('Enter')
  await expect(bar.queuedRows).toHaveText(['1Keep the original filenames in the bucket keys.'])
  expect((await allTasks(first.window)).map(({ activity }) => activity)).toEqual([
    TaskActivity.Working,
    TaskActivity.Working,
    TaskActivity.Working,
  ])

  // Force-quit in the middle of all three turns: nothing runs on the way out.
  await first.kill()

  // On relaunch all three carry on in their own sessions, and the notice says so.
  const second = await launch({ agentScriptsByFirstMessage: SCRIPTS })
  const { window } = second
  const notice = relaunchNotice(window)
  await expect(notice.notice).toContainText('Glade quit unexpectedly')
  await expect(notice.notice).toContainText(
    'Everything was saved. 3 tasks were mid-turn and have picked up where they left off.',
  )
  await expect
    .poll(async () => (await allTasks(window)).map(({ activity }) => activity))
    .toEqual([TaskActivity.Waiting, TaskActivity.Waiting, TaskActivity.Waiting])
  const relaunched = taskList(window)
  const { userMessages, agentReplies, restarts } = chat(window)
  const expected = [
    { title: 'Run the e2e suite', reply: 'The end-to-end suite passes: all 41 tests.' },
    { title: 'Build the release', reply: 'The release is built: dist/glade-0.3.0.dmg.' },
    {
      title: 'Move image uploads to S3',
      reply: 'All 3,900 files are in the bucket, and their keys keep the original filenames.',
    },
  ]
  for (const { title, reply } of expected) {
    await relaunched.row('Active', title).click()
    await expect(restarts).toHaveCount(1)
    await expect(agentReplies).toHaveCount(1)
    await expect(agentReplies.first()).toContainText(reply)
  }

  // The copy's queued message was delivered into its resumed turn, which answered it.
  await expect(userMessages).toHaveText([/Move image uploads to S3\./, /Keep the original filenames/])
  await expect(inputBar(window).queued).toHaveCount(0)

  // The notice stays until it's dismissed, across a relaunch too; Show them opens one of the tasks.
  await second.close()
  const third = await launch({ agentScriptsByFirstMessage: SCRIPTS })
  const kept = relaunchNotice(third.window)
  await expect(kept.notice).toBeVisible()
  await taskList(third.window).row('Active', 'Build the release').click()
  await kept.showThem.click()
  await expect(kept.notice).toHaveCount(0)
  await expect(taskHeader(third.window).title).toHaveText('Run the e2e suite')

  // Dismissed, and quit cleanly: no notice on the next launch.
  await third.close()
  const fourth = await launch({ agentScriptsByFirstMessage: SCRIPTS })
  await expect(taskHeader(fourth.window).title).toHaveText('Run the e2e suite')
  await expect(relaunchNotice(fourth.window).notice).toHaveCount(0)
})

test('the relaunch notice goes away when dismissed', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const first = await launch({ agentScript: 'long-running', chosenFolder: root })
  await firstRun(first.window).openFolder.click()
  await taskList(first.window).newTask.click()
  await inputBar(first.window).field.fill(RUN_SUITE)
  await inputBar(first.window).field.press('Enter')
  await expect(taskPanel(first.window).call(/^Running\s*Bash/)).toBeVisible()
  await first.kill()

  const { window } = await launch({ agentScript: 'long-running' })
  const notice = relaunchNotice(window)
  await expect(notice.notice).toBeVisible()
  await notice.dismiss.click()
  await expect(notice.notice).toHaveCount(0)
  await expect(chat(window).agentReplies.first()).toContainText('The end-to-end suite passes: all 41 tests.')
})
