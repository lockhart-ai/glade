import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { PARALLEL_SUBAGENTS } from '../src/main/agent/scripts'
import { expect, test } from './fixtures'
import { agentsTab, firstRun, inputBar, taskList, taskPanel } from './selectors'

test('subagents: a tab per subagent, running first, each saying what it’s doing, that open their logs and tick until stopped', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'parallel-subagents', chosenFolder: root })
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const bar = inputBar(window)
  await bar.field.fill('Draft release notes for 2.4 from the PRs merged since the 2.3 tag.')
  await bar.field.press('Enter')

  const panel = taskPanel(window)
  const agents = agentsTab(window)
  await panel.tab(/^Agents/).click()

  // Three subagents ran side by side: the link check finished, the other two are still at it.
  await expect(panel.tab(/^Agents/)).toHaveText('Agents 4')
  expect(await agents.tabs.evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('title')))).toEqual([
    'Main',
    'API changes',
    'Dashboard changes',
    'Check links in the 2.3 notes',
  ])

  // Each says what it's doing: its latest call, or the last thing it said, or what it finished with.
  const api = agents.agentCall('API changes')
  await expect(api).toContainText('Running')
  await expect(api).toContainText('Readapi/throttles.py')
  await expect(api).toContainText('3 tool calls')
  await expect(agents.agentCall('Dashboard changes')).toContainText(
    '“#1418 moves the charts onto the new query, so it belongs under features, not fixes.”',
  )
  const links = agents.agentCall('Check links in the 2.3 notes')
  await expect(links).toContainText('Done')
  await expect(links).toContainText('Found 2 broken links and fixed both in the draft.')
  await expect(links).toContainText(/\d+s · 2 tool calls/)

  // A running one also says what it's doing now, under its name: the SDK's latest summary, on one line, whole in its
  // tooltip. The link check's summary came after it finished, so it has none.
  const apiSummary = api.getByTitle(PARALLEL_SUBAGENTS.apiSummary)
  await expect(apiSummary).toHaveText(PARALLEL_SUBAGENTS.apiSummary)
  await expect(agents.agentCall('Dashboard changes').getByTitle(PARALLEL_SUBAGENTS.dashboardSummary)).toBeVisible()
  await expect(links).not.toContainText('Checking the last links')
  const clamped = await apiSummary.evaluate((element) => ({
    cut: element.scrollWidth > element.clientWidth,
    lines: Math.round(element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight)),
  }))
  expect(clamped).toEqual({ cut: true, lines: 1 })

  // A running subagent's elapsed time ticks; a finished one's has stopped.
  await expect(api).toContainText(/\d+s · 3 tool calls/)
  const [apiBefore, linksBefore] = [await api.textContent(), await links.textContent()]
  await expect(api).not.toHaveText(apiBefore ?? '')
  await expect(links).toHaveText(linksBefore ?? '')

  // The task's row counts the running ones, on the line under its status.
  const list = taskList(window)
  const row = list.rows('Active').first()
  await expect(list.subagentCount(row)).toHaveAccessibleName('2 subagents running')
  await expect(list.subagentCount(row)).toHaveAttribute('title', '2 subagents running')
  await expect(list.indicators(row)).toHaveText('2')

  // Clicking the call opens its tab, as the log shows it; the tab stays selected until another one is.
  await api.click()
  await expect(agents.tab('API changes')).toHaveAttribute('aria-selected', 'true')
  await expect(agents.list).toContainText('Reading the API PRs, newest first.')
  await expect(agents.list.getByRole('button')).toHaveCount(3)
  await expect(agents.list.getByRole('button').last()).toHaveAccessibleName(/^Running\s*Read\s*api\/throttles\.py/)
  await agents.list.getByRole('button').first().click()
  await expect(agents.list.getByLabel('Bash output')).toContainText('Rate limit the public API')
  await agents.tab('Main').click()
  await expect(agents.tab('Main')).toHaveAttribute('aria-selected', 'true')

  // Stopping the turn stops the subagents still running.
  await bar.stop.click()
  await expect(agents.agentCall('API changes')).toContainText('Failed')
  await expect(agents.agentCall('Dashboard changes')).toContainText('Failed')
  await expect(agents.agentCall('Check links in the 2.3 notes')).toContainText('Done')
  // A stopped subagent isn't doing anything now.
  await expect(apiSummary).toHaveCount(0)
  await expect(agents.agentCall('API changes')).not.toContainText(PARALLEL_SUBAGENTS.apiSummary)
  // With none running, the row's count goes, and its third line with it.
  await expect(list.subagentCount(row)).toHaveCount(0)
  await expect(list.indicators(row)).toHaveCount(0)
})
