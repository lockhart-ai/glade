import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { SUBAGENT_BACKGROUND_WORK as WORK } from '../src/main/agent/scripts'
import { expect, test } from './fixtures'
import {
  chat,
  contextMenu,
  firstRun,
  inputBar,
  subagentsTab,
  taskList,
  taskPanel,
  watchersTab,
  watchingMark,
} from './selectors'

// #291: what a subagent leaves running in the background is the subagent's, under it in the Subagents tab, not the
// task's own watchers; a foreground command is never one; and it ends with its subagent when that's stopped.
test('subagent watchers: a subagent’s background work is under it, not counted as the task’s, and ends with it', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'subagent-background-work', chosenFolder: root })
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  await list.newTask.click()
  const bar = inputBar(window)
  await bar.field.fill(WORK.prompt)
  await bar.field.press('Enter')
  await expect(chat(window).agentReplies.first()).toContainText(WORK.started)

  // The subagent's lint finishes and its e2e suite runs on, under it; its foreground unit tests aren't a watcher.
  const panel = taskPanel(window)
  const subagents = subagentsTab(window)
  await panel.tab(/^Subagents/).click()
  await expect(subagents.log(WORK.subagent)).toHaveCount(0)
  await expect(subagents.watching(WORK.subagent)).toHaveAccessibleName('1 watcher running')
  await subagents.header(WORK.subagent).click()
  await expect(subagents.log(WORK.subagent)).toContainText(WORK.waiting)
  const work = subagents.background(WORK.subagent)
  const rows = work.locator('[data-state][role="group"]')
  await expect(rows).toHaveCount(2)
  expect(await rows.evaluateAll((each) => each.map((row) => row.getAttribute('aria-label')))).toEqual([
    WORK.e2e,
    WORK.lint,
  ])
  await expect(work.getByRole('group', { name: WORK.e2e })).toHaveAttribute('data-state', 'running')
  await expect(work.getByRole('group', { name: WORK.e2e })).toContainText(`Command${WORK.e2eCommand}`)
  await expect(work.getByRole('group', { name: WORK.lint })).toHaveAttribute('data-state', 'finished')
  await expect(work.getByRole('group', { name: WORK.lint })).toContainText(WORK.lintDone)
  await expect(work).not.toContainText(WORK.unitTests)

  // The task's own Watchers tab, and its row in the task list, count only its own: the deploy log.
  await expect(panel.tab(/^Watch/)).toHaveText('Watchers 1')
  await expect(watchingMark(list.taskRow(WORK.title))).toHaveAccessibleName('1 watcher running')
  await panel.tab(/^Watch/).click()
  const watchers = watchersTab(window)
  await expect(watchers.rows).toHaveCount(1)
  await expect(watchers.row(WORK.deploy)).toHaveAttribute('data-state', 'running')

  // Stopping the subagent ends what it left running, and the task's own runs on.
  await panel.tab(/^Subagents/).click()
  await subagents.header(WORK.subagent).click({ button: 'right' })
  await contextMenu(window, 'Subagent actions').item('Stop subagent').click()
  await expect(subagents.header(WORK.subagent)).toContainText('You stopped the subagent.')
  await expect(subagents.watching(WORK.subagent)).toHaveCount(0)
  // The tab opened afresh, with its rows shut.
  await subagents.header(WORK.subagent).click()
  await expect(work.getByRole('group', { name: WORK.e2e })).toHaveAttribute('data-state', 'stopped')
  await expect(work.getByRole('group', { name: WORK.e2e })).toContainText('Ended with its subagent.')
  await expect(panel.tab(/^Watch/)).toHaveText('Watchers 1')
})
