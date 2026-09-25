import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { chat, firstRun, inputBar, subagentsTab, taskList, taskPanel } from './selectors'

// What the subagent-calls agent says when its turn ends (`SUBAGENT_CALLS_REPLY` in src/main/agent/scripts.ts).
const REPLY = 'The 2.4 notes are drafted'
const TITLE = 'Draft release notes for 2.4'

/** The tool log's rows: the task's own calls, the Agent calls that started its subagents among them. */
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

/** Checks both panels: the tool log shows only the task's own calls, and each subagent's calls are under it. */
async function checkBothPanels(window: Page): Promise<void> {
  const panel = taskPanel(window)
  await panel.tab(/^Tool calls/).click()
  await expect(panel.tab(/^Tool calls/)).toHaveText('Tool calls 9')
  await expect(panel.log.getByRole('button')).toHaveCount(PARENT_ROWS.length)
  for (const [index, name] of PARENT_ROWS.entries()) {
    await expect(panel.log.getByRole('button').nth(index)).toHaveAccessibleName(name)
  }
  // None of the subagents' calls or notes, nested or failed, is in it.
  await expect(panel.log).not.toContainText(/gh pr|redis-cli|throttles|charts\.ts|2\.3\.md|curl|Listing the merged/)
  await expect(panel.log.getByRole('group')).toHaveCount(0)

  // Each subagent lists its own calls, in order, with how each went.
  const subagents = subagentsTab(window)
  await panel.tab(/^Subagents/).click()
  await expect(panel.tab(/^Subagents/)).toHaveText('Subagents 4')
  await expect(subagents.tally).toHaveText('4 done')
  await expect(subagents.header('API changes')).toContainText('2 tool calls')
  await subagents.header('API changes').click()
  const api = subagents.log('API changes')
  await expect(api).toContainText('Listing the merged API PRs.')
  await expect(api.getByRole('button')).toHaveCount(4)
  await expect(api.getByRole('button').nth(0)).toHaveAccessibleName(/^Done Bash gh pr list --label api/)
  await expect(api.getByRole('button').nth(1)).toHaveAccessibleName(/^Done Agent Read PR 1402/)
  // The nested subagent's calls sit under its Agent call, and in its own entry.
  await expect(api.getByRole('button').nth(2)).toHaveAccessibleName(/^Done Bash gh pr view 1402/)
  await expect(api.getByRole('button').nth(3)).toHaveAccessibleName(/^Done Read api\/throttles\.py/)
  await subagents.header('API changes').click()
  await subagents.header('Read PR 1402').click()
  await expect(subagents.log('Read PR 1402').getByRole('button')).toHaveCount(2)
  await subagents.header('Read PR 1402').click()

  // The dashboard one's failed call is pink, and opens on its error.
  await subagents.header('Dashboard changes').click()
  const dashboard = subagents.log('Dashboard changes')
  await expect(dashboard.getByRole('button')).toHaveCount(3)
  const failed = dashboard.getByRole('button').first()
  await expect(failed).toHaveAccessibleName(/^Failed Bash redis-cli/)
  await failed.click()
  await expect(dashboard.getByLabel('Bash output')).toContainText('Connection refused')
  await subagents.header('Dashboard changes').click()

  // The background one's calls are under it too.
  await subagents.header('Check links in the 2.3 notes').click()
  const links = subagents.log('Check links in the 2.3 notes')
  await expect(links.getByRole('button')).toHaveCount(2)
  await expect(links.getByRole('button').first()).toHaveAccessibleName(/^Done Read docs\/releases\/2\.3\.md/)
  await expect(links.getByRole('button').last()).toHaveAccessibleName(/^Done Bash curl -sI/)
  await subagents.header('Check links in the 2.3 notes').click()
}

test('subagent tool calls: the tool log shows only the parent’s, each subagent’s are under it in Subagents', async ({
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
    .tab(/^Subagents/)
    .click()
  await expect(subagentsTab(first.window).tally).toHaveText('4 done')

  await checkBothPanels(first.window)

  // It all reads back the same after a relaunch.
  await first.close()
  const second = await launch({ agentScript: 'subagent-calls' })
  await taskList(second.window).taskRow(TITLE).click()
  await checkBothPanels(second.window)
})
