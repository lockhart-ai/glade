import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { WAKES_A_SUBAGENT } from '../src/main/agent/scripts'
import { expect, test } from './fixtures'
import { chat, firstRun, inputBar, subagentsTab, taskList, taskPanel } from './selectors'

// A subagent woken again by the agent's `SendMessage` (#395): it runs again in its own row, counted on the task's row,
// until its new run ends (`WAKES_A_SUBAGENT` in src/main/agent/scripts.ts).
const { title, subagent: SUBAGENT } = WAKES_A_SUBAGENT

test('a subagent the agent messages after it finished runs again, then ends again', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'wakes-a-subagent', chosenFolder: root })
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  await list.newTask.click()
  const bar = inputBar(window)
  await bar.field.fill(WAKES_A_SUBAGENT.prompt)
  await bar.field.press('Enter')

  const { agentReplies } = chat(window)
  await expect(agentReplies.first()).toContainText(WAKES_A_SUBAGENT.started)
  await taskPanel(window)
    .tab(/^Subagents/)
    .click()
  const subagents = subagentsTab(window)
  const row = subagents.header(SUBAGENT)
  await expect(row).toContainText('Done')
  await expect(row).toContainText(WAKES_A_SUBAGENT.found)
  await expect(list.subagentCount(list.taskRow(title))).toHaveCount(0)

  // The agent messages it: it's running again in the same row, with what it's doing now, and the task's row counts it.
  await bar.field.fill(WAKES_A_SUBAGENT.ask)
  await bar.field.press('Enter')
  await expect(agentReplies.nth(1)).toContainText(WAKES_A_SUBAGENT.asked)
  await expect(subagents.rows).toHaveCount(1)
  await expect(subagents.tally).toHaveText('1 running')
  await expect(row).toContainText('Running')
  await expect(subagents.summary(SUBAGENT, WAKES_A_SUBAGENT.summary)).toBeVisible()
  await expect(list.subagentCount(list.taskRow(title))).toHaveAccessibleName('1 subagent running')
  // What it did before is still in its log, with what it does now.
  await expect(row).toContainText(/4 tool calls/)

  // Its new run ends: done again, with what it came to, and the agent reports it.
  await expect(row).toContainText('Done', { timeout: 20_000 })
  await expect(row).toContainText(WAKES_A_SUBAGENT.fixed)
  await expect(subagents.tally).toHaveText('1 done')
  await expect(list.subagentCount(list.taskRow(title))).toHaveCount(0)
  await expect(agentReplies.nth(2)).toContainText(WAKES_A_SUBAGENT.reported)
})

test('a subagent interrupted by a relaunch runs again when the agent messages it', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const first = await launch({ agentScript: 'wakes-a-subagent', chosenFolder: root })
  await firstRun(first.window).openFolder.click()
  await taskList(first.window).newTask.click()
  const firstBar = inputBar(first.window)
  await firstBar.field.fill(WAKES_A_SUBAGENT.prompt)
  await firstBar.field.press('Enter')
  await expect(chat(first.window).agentReplies.first()).toContainText(WAKES_A_SUBAGENT.started)
  await taskPanel(first.window)
    .tab(/^Subagents/)
    .click()
  await expect(subagentsTab(first.window).header(SUBAGENT)).toContainText('Running')
  await first.close()

  const second = await launch({ agentScript: 'wakes-an-interrupted-subagent' })
  const list = taskList(second.window)
  await list.taskRow(title).click()
  await taskPanel(second.window)
    .tab(/^Subagents/)
    .click()
  const subagents = subagentsTab(second.window)
  const row = subagents.header(SUBAGENT)
  await expect(row).toContainText('Interrupted')

  const bar = inputBar(second.window)
  await bar.field.fill(WAKES_A_SUBAGENT.ask)
  await bar.field.press('Enter')
  await expect(chat(second.window).agentReplies.last()).toContainText(WAKES_A_SUBAGENT.asked)
  await expect(row).toContainText('Running')
  await expect(subagents.tally).toHaveText('1 running')
  await expect(list.subagentCount(list.taskRow(title))).toHaveAccessibleName('1 subagent running')

  await expect(row).toContainText('Done', { timeout: 20_000 })
  await expect(row).toContainText(WAKES_A_SUBAGENT.fixed)
  await expect(list.subagentCount(list.taskRow(title))).toHaveCount(0)
})
