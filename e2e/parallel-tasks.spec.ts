import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { chat, firstRun, inputBar, taskHeader, taskList, taskPanel } from './selectors'

/** Task A's first message: it plays `long-running`, which works until it's stopped. */
const RUN_SUITE = 'Run the e2e suite.'
/** Task B's first message: it plays `multi-tool-turn`, which finishes a turn of twelve tool calls. */
const FIX_DATE = 'The date test is flaky. Can you fix it?'

test('two tasks work at once, each with its own chat and tool log, and stopping one leaves the other be', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({
    agentScriptsByFirstMessage: { [RUN_SUITE]: 'long-running', [FIX_DATE]: 'multi-tool-turn' },
    chosenFolder: root,
  })
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  const bar = inputBar(window)
  const { userMessages, agentReplies } = chat(window)
  const panel = taskPanel(window)
  const header = taskHeader(window)
  const rowA = list.row('Active', 'Run the e2e suite')
  const rowB = list.row('Active', 'Fix the flaky date test')

  // Task A starts a turn that keeps working.
  await list.newTask.click()
  await bar.field.fill(RUN_SUITE)
  await bar.field.press('Enter')
  await expect(panel.call(/^Running\s*Bash/)).toBeVisible()
  await expect(header.stateDot).toHaveAccessibleName('Active · working')

  // Task B runs a whole turn while A keeps working.
  await list.newTask.click()
  await expect(list.rows('Active')).toHaveCount(2)
  await expect(userMessages).toHaveCount(0)
  await bar.field.fill(FIX_DATE)
  await bar.field.press('Enter')
  await expect(agentReplies).toHaveCount(1)
  await expect(agentReplies.first()).toContainText('The failing test was a timezone bug')
  await expect(header.title).toHaveText('Fix the flaky date test')
  await expect(header.stateDot).toHaveAccessibleName('Active · waiting on you')
  await expect(panel.tab(/^Tool calls/)).toHaveText('Tool calls 10')
  await expect(panel.log.getByRole('button', { name: /^Done/ })).toHaveCount(10)
  await expect(panel.call(/Bash\s*npm run test:e2e/)).toHaveCount(0)

  // In the sidebar, A is still working while B, selected, waits on you.
  await expect(rowB).toHaveAttribute('aria-current', 'true')
  await expect(list.dot(rowA)).toHaveAttribute('data-state', 'working')
  await expect(list.dot(rowB)).toHaveAttribute('data-state', 'waiting')
  await expect(rowA).toContainText('Running the e2e suite.')

  // Back to A: its own chat and tool log, still working, with nothing of B's.
  await rowA.click()
  await expect(header.title).toHaveText('Run the e2e suite')
  await expect(header.stateDot).toHaveAccessibleName('Active · working')
  await expect(userMessages).toHaveCount(1)
  await expect(userMessages.first()).toContainText(RUN_SUITE)
  await expect(agentReplies).toHaveCount(0)
  await expect(panel.tab(/^Tool calls/)).toHaveText('Tool calls 4')
  await expect(panel.call(/^Running\s*Bash/)).toBeVisible()
  await expect(panel.call(/Read\s*src\/date\.ts/)).toHaveCount(0)

  // And to B again: unchanged, and A keeps working.
  await rowB.click()
  await expect(header.title).toHaveText('Fix the flaky date test')
  await expect(userMessages).toHaveCount(1)
  await expect(userMessages.first()).toContainText(FIX_DATE)
  await expect(agentReplies).toHaveCount(1)
  await expect(panel.tab(/^Tool calls/)).toHaveText('Tool calls 10')
  await expect(list.dot(rowA)).toHaveAttribute('data-state', 'working')

  // Stopping A ends only A's turn.
  await rowA.click()
  await expect(header.title).toHaveText('Run the e2e suite')
  await bar.stop.click()
  await expect(header.stateDot).toHaveAccessibleName('Active · waiting on you')
  await expect(panel.call(/^Failed\s*Bash/)).toHaveAccessibleName(/You stopped the agent\.$/)
  await expect(list.dot(rowA)).toHaveAttribute('data-state', 'waiting')

  await rowB.click()
  await expect(header.title).toHaveText('Fix the flaky date test')
  await expect(header.stateDot).toHaveAccessibleName('Active · waiting on you')
  await expect(agentReplies).toHaveCount(1)
  await expect(panel.log.getByRole('button', { name: /^Done/ })).toHaveCount(10)
  await expect(panel.call(/^Failed/)).toHaveCount(0)
  await expect(panel.log).not.toContainText('You stopped the agent.')
})
