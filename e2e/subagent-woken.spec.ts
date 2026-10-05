import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { WAKES_A_SUBAGENT } from '../src/main/agent/scripts'
import { expect, test } from './fixtures'
import { agentsTab, chat, firstRun, inputBar, taskList, taskPanel } from './selectors'

// A subagent woken again by the agent's `SendMessage` (#395): it runs again on its own tab, counted on the task's
// row, until its new run ends (`WAKES_A_SUBAGENT` in src/main/agent/scripts.ts).
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
    .tab(/^Agents/)
    .click()
  const agents = agentsTab(window)
  const call = agents.agentCall(SUBAGENT)
  await expect(call).toContainText('Done')
  await expect(call).toContainText(WAKES_A_SUBAGENT.found)
  await expect(list.subagentCount(list.taskRow(title))).toHaveCount(0)

  // The agent messages it: it's running again on the same tab, with what it's doing now, and the task's row counts it.
  await bar.field.fill(WAKES_A_SUBAGENT.ask)
  await bar.field.press('Enter')
  await expect(agentReplies.nth(1)).toContainText(WAKES_A_SUBAGENT.asked)
  await expect(agents.tabs).toHaveCount(2)
  await expect(agents.tab(SUBAGENT)).toHaveAttribute('data-running', '')
  await expect(call).toContainText('Running')
  await expect(list.subagentCount(list.taskRow(title))).toHaveAccessibleName('1 subagent running')
  // What it did before is still in its log, with what it does now.
  await agents.tab(SUBAGENT).click()
  await expect(agents.list).toContainText(/4 tool calls/)

  // Its new run ends: done again, with what it came to, and the agent reports it.
  await expect(call).toContainText('Done', { timeout: 20_000 })
  await expect(call).toContainText(WAKES_A_SUBAGENT.fixed)
  await expect(agents.tab(SUBAGENT)).not.toHaveAttribute('data-running')
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
    .tab(/^Agents/)
    .click()
  await expect(agentsTab(first.window).agentCall(SUBAGENT)).toContainText('Running')
  await first.close()

  const second = await launch({ agentScript: 'wakes-an-interrupted-subagent' })
  const list = taskList(second.window)
  await list.taskRow(title).click()
  await taskPanel(second.window)
    .tab(/^Agents/)
    .click()
  const agents = agentsTab(second.window)
  const call = agents.agentCall(SUBAGENT)
  await expect(call).toContainText('Interrupted')

  const bar = inputBar(second.window)
  await bar.field.fill(WAKES_A_SUBAGENT.ask)
  await bar.field.press('Enter')
  await expect(chat(second.window).agentReplies.last()).toContainText(WAKES_A_SUBAGENT.asked)
  await expect(call).toContainText('Running')
  await expect(agents.tab(SUBAGENT)).toHaveAttribute('data-running', '')
  await expect(list.subagentCount(list.taskRow(title))).toHaveAccessibleName('1 subagent running')

  await expect(call).toContainText('Done', { timeout: 20_000 })
  await expect(call).toContainText(WAKES_A_SUBAGENT.fixed)
  await expect(list.subagentCount(list.taskRow(title))).toHaveCount(0)
})
