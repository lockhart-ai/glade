import { expect, seedPath, test } from './fixtures'
import { regions, taskPanel } from './selectors'

test('tool log: rows, notes, dividers and subagent calls; a row expands; the chat shows a turn; it survives a restart', async ({
  launch,
}) => {
  const glade = await launch({ seed: seedPath('tool-log.json') })
  const panel = taskPanel(glade.window)

  // Tool calls is the live tab, counting every call, subagents' included.
  await expect(panel.tab(/^Tool calls/)).toHaveAttribute('aria-selected', 'true')
  await expect(panel.tab(/^Tool calls/)).toHaveText('Tool calls 7')

  // Each row has its name, argument (paths relative to the workspace) and short result, in the state's colour.
  await expect(panel.call(/^Done Read api\/views\.py/)).toContainText('3 lines')
  await expect(panel.call(/^Done Bash pytest api\/tests -q/)).toContainText('14 passed in 3.2s')
  await expect(panel.call(/^Failed Bash python manage\.py check/)).toContainText('SystemCheckError')
  await expect(panel.call(/^Running Edit config\/settings\.py/)).toContainText('Running…')
  await expect(panel.call(/set_status/)).toContainText('{"status":"Giving /search its own limit"}')

  // A subagent's calls sit under the Agent call that started it.
  await expect(panel.subagentCalls('Agent').getByRole('button')).toHaveCount(1)
  await expect(panel.subagentCalls('Agent')).toContainText('Grep')

  // Notes sit between the rows, and a divider marks the start of turn 2 (turn 1 needs none).
  await expect(panel.log).toContainText('Looking at how the API views are set up.')
  await expect(panel.dividers).toHaveCount(1)
  await expect(panel.dividers.first()).toHaveAccessibleName(/^turn 2 · \d\d:\d\d$/)

  // Clicking a row shows its full output.
  const pytest = panel.call(/Bash pytest api\/tests -q/)
  await pytest.click()
  await expect(pytest).toHaveAttribute('aria-expanded', 'true')
  await expect(panel.log.getByLabel('Bash output')).toContainText('[100%]')
  await pytest.click()
  await expect(panel.log.getByLabel('Bash output')).toHaveCount(0)

  // The chat's tool-call chip brings back Tool calls, at that turn, from any other tab.
  await panel.tab('Files').click()
  await expect(panel.tabPanel).toContainText('No file open.')
  await regions(glade.window).chat.getByRole('button', { name: '3 tool calls' }).click()
  await expect(panel.tab(/^Tool calls/)).toHaveAttribute('aria-selected', 'true')
  await expect(panel.log.locator('[data-turn-start="1"]')).toBeInViewport()

  // The log is read back from the database after a restart.
  await glade.close()
  const relaunched = taskPanel((await launch()).window)
  await expect(relaunched.tab(/^Tool calls/)).toHaveText('Tool calls 7')
  await expect(relaunched.call(/Read api\/views\.py/)).toContainText('3 lines')
  await expect(relaunched.dividers).toHaveCount(1)
})
