import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { CommandName } from '../src/shared/bridge'
import { TaskActivity, type Task } from '../src/shared/domain'
import { expect, test } from './fixtures'
import { chat, firstRun, inputBar, taskList, taskPanel } from './selectors'
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
  const sessionId = (await onlyTask(first.window))?.sessionId
  expect(sessionId).toBeTruthy()

  // Force-quit in the middle of the turn: nothing runs on the way out.
  await first.kill()

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

  // The tool log keeps what the first run did: the command the quit cut off failed, then the turn resumed.
  const panel = taskPanel(window)
  await expect(panel.call(/^Failed\s*Bash/)).toBeVisible()
  await expect(panel.dividers.filter({ hasText: /^resumed after restart/ })).toHaveCount(1)
  await expect(panel.call(/^Done\s*Bash/)).toBeVisible()
  await expect(panel.log).toContainText('Glade restarted mid-run, so I am running the suite again.')

  await expect.poll(async () => (await onlyTask(window))?.activity).toBe(TaskActivity.Waiting)
  expect((await onlyTask(window))?.sessionId).toBe(sessionId)
  await expect(taskList(window).rows('Active').first()).toContainText('The e2e suite passes.')
})
