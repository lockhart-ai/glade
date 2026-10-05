import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { agentsTab, chat, firstRun, inputBar, taskList, taskPanel } from './selectors'

// What the subagent-calls agent says when its turn ends (`SUBAGENT_CALLS_REPLY` in src/main/agent/scripts.ts).
const REPLY = 'The 2.4 notes are drafted'
const TITLE = 'Draft release notes for 2.4'

/** Main's tool log's rows: its own calls, the Agent calls that started its subagents among them. */
const PARENT_ROWS = [
  /^Done set_title/,
  /^Done set_objective/,
  /^Done set_status/,
  /^Done Read CHANGELOG\.md/,
  /^Done Agent API changes/,
  /^Done Agent Dashboard changes/,
  /^Done Write docs\/releases\/2\.4\.md/,
  /^Done Agent Check links in the 2\.3 notes/,
  /^Done set_status/,
]

/** Checks every agent's own tab: Main's log shows only its own calls, and each subagent's are under its own tab. */
async function checkEveryAgent(window: Page): Promise<void> {
  const panel = taskPanel(window)
  const agents = agentsTab(window)
  await panel.tab(/^Agents/).click()
  await expect(panel.tab(/^Agents/)).toHaveText('Agents 5')

  await agents.tab('Main').click()
  await expect(agents.list.getByRole('button')).toHaveCount(PARENT_ROWS.length)
  for (const [index, name] of PARENT_ROWS.entries()) {
    await expect(agents.list.getByRole('button').nth(index)).toHaveAccessibleName(name)
  }
  // None of the subagents' calls or notes, nested or failed, is in Main's own log.
  await expect(agents.list).not.toContainText(/gh pr|redis-cli|throttles|charts\.ts|2\.3\.md|curl|Listing the merged/)
  await expect(agents.list.getByRole('group')).toHaveCount(0)

  // Each subagent's own tab lists its own calls, in order, with how each went.
  await agents.tab('API changes').click()
  await expect(agents.list).toContainText('Listing the merged API PRs.')
  await expect(agents.list.getByRole('button')).toHaveCount(4)
  await expect(agents.list.getByRole('button').nth(0)).toHaveAccessibleName(/^Done Bash gh pr list --label api/)
  await expect(agents.list.getByRole('button').nth(1)).toHaveAccessibleName(/^Done Agent Read PR 1402/)
  // The nested subagent's calls sit under its Agent call there, and on its own tab.
  await expect(agents.list.getByRole('button').nth(2)).toHaveAccessibleName(/^Done Bash gh pr view 1402/)
  await expect(agents.list.getByRole('button').nth(3)).toHaveAccessibleName(/^Done Read api\/throttles\.py/)
  await agents.tab('Read PR 1402').click()
  await expect(agents.list.getByRole('button')).toHaveCount(2)

  // The dashboard one's failed call is pink, and opens on its error.
  await agents.tab('Dashboard changes').click()
  await expect(agents.list.getByRole('button')).toHaveCount(3)
  const failed = agents.list.getByRole('button').first()
  await expect(failed).toHaveAccessibleName(/^Failed Bash redis-cli/)
  await failed.click()
  await expect(agents.list.getByLabel('Bash output')).toContainText('Connection refused')

  // The background one's calls are under its own tab too.
  await agents.tab('Check links in the 2.3 notes').click()
  await expect(agents.list.getByRole('button')).toHaveCount(2)
  await expect(agents.list.getByRole('button').first()).toHaveAccessibleName(/^Done Read docs\/releases\/2\.3\.md/)
  await expect(agents.list.getByRole('button').last()).toHaveAccessibleName(/^Done Bash curl -sI/)
}

test('subagent tool calls: each agent’s tab shows only its own calls, the nested subagent’s included', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const first = await launch({ agentScript: 'subagent-calls', chosenFolder: root })
  await firstRun(first.window).openFolder.click()
  await taskList(first.window).newTask.click()
  const bar = inputBar(first.window)
  await bar.field.fill('Draft release notes for 2.4 from the PRs merged since the 2.3 tag.')
  await bar.field.press('Enter')
  await expect(chat(first.window).agentReplies.first()).toContainText(REPLY)
  // The background subagent finishes after the turn.
  await taskPanel(first.window)
    .tab(/^Agents/)
    .click()
  await expect(taskPanel(first.window).tab(/^Agents/)).toHaveText('Agents 5')

  await checkEveryAgent(first.window)

  // It all reads back the same after a relaunch.
  await first.close()
  const second = await launch({ agentScript: 'subagent-calls' })
  await taskList(second.window).taskRow(TITLE).click()
  await checkEveryAgent(second.window)
})
