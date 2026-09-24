import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { firstRun, inputBar, subagentsTab, taskList, taskPanel } from './selectors'

test('subagents: a tally and a row per subagent, running first, that open their logs and tick until stopped', async ({
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
  const subagents = subagentsTab(window)
  await panel.tab(/^Subagents/).click()

  // Three subagents ran side by side: the link check finished, the other two are still at it.
  await expect(panel.tab(/^Subagents/)).toHaveText('Subagents 3')
  await expect(subagents.tally).toHaveText('2 running1 done')
  await expect(subagents.rows).toHaveCount(3)
  expect(await subagents.rows.evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label')))).toEqual([
    'API changes',
    'Dashboard changes',
    'Check links in the 2.3 notes',
  ])

  // Each says what it's doing: its latest call, or the last thing it said, or what it finished with.
  const api = subagents.header('API changes')
  await expect(api).toContainText('Running')
  await expect(api).toContainText('Readapi/throttles.py')
  await expect(api).toContainText('3 tool calls')
  await expect(subagents.header('Dashboard changes')).toContainText(
    '“#1418 moves the charts onto the new query, so it belongs under features, not fixes.”',
  )
  const links = subagents.header('Check links in the 2.3 notes')
  await expect(links).toContainText('Done')
  await expect(links).toContainText('Found 2 broken links and fixed both in the draft.')
  await expect(links).toContainText(/\d+s · 2 tool calls/)

  // A running subagent's elapsed time ticks; a finished one's has stopped.
  await expect(api).toContainText(/\d+s · 3 tool calls/)
  const [apiBefore, linksBefore] = [await api.textContent(), await links.textContent()]
  await expect(api).not.toHaveText(apiBefore ?? '')
  await expect(links).toHaveText(linksBefore ?? '')

  // Clicking a row opens its log inline, as the tool log shows it; clicking again closes it.
  await api.click()
  await expect(api).toHaveAttribute('aria-expanded', 'true')
  const log = subagents.log('API changes')
  await expect(log).toContainText('Reading the API PRs, newest first.')
  await expect(log.getByRole('button')).toHaveCount(3)
  await expect(log.getByRole('button').last()).toHaveAccessibleName(/^Running\s*Read\s*api\/throttles\.py/)
  await log.getByRole('button').first().click()
  await expect(log.getByLabel('Bash output')).toContainText('Rate limit the public API')
  await api.click()
  await expect(api).toHaveAttribute('aria-expanded', 'false')
  await expect(log).toBeHidden()

  // Stopping the turn stops the subagents still running.
  await bar.stop.click()
  await expect(subagents.tally).toHaveText('1 done2 failed')
  await expect(subagents.header('API changes')).toContainText('Failed')
  expect(await subagents.rows.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-status')))).toEqual([
    'done',
    'error',
    'error',
  ])
})
