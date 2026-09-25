import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { chat, contextMenu, firstRun, inputBar, subagentsTab, taskList, taskPanel } from './selectors'

// What the background-subagents agent says (`BACKGROUND_SUBAGENTS` in src/main/agent/scripts.ts).
const TITLE = 'Find why checkout is slow'
const STARTED = "I've started three subagents on the slow checkout. I'll report back as they finish."
const MEANWHILE = 'The subagents are still at it. The cart cache is the likeliest suspect so far.'
const PROFILED =
  'Checkout runs one query per cart item: an N+1 in load_cart. Batching it takes p95 from 840 ms to 95 ms.'
const CACHE_FAILED = "Couldn't reach the Redis staging instance: connection refused."
const REPORTED =
  'The query profile is back: checkout has an N+1 in load_cart. Batching it should take p95 to about 95 ms.'

test('background subagents: they run until they really end, while the parent waits on you and takes messages', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'background-subagents', chosenFolder: root })
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  await list.newTask.click()
  const bar = inputBar(window)
  await bar.field.fill('Find why the checkout endpoint got slower since 2.3.')
  await bar.field.press('Enter')

  // The turn that started them has ended: the parent waits on you, while all three subagents run.
  const { agentReplies, userMessages } = chat(window)
  await expect(agentReplies).toHaveCount(1)
  await expect(agentReplies.first()).toContainText(STARTED)
  await expect(list.dot(list.taskRow(TITLE))).toHaveAttribute('data-state', 'waiting')
  const panel = taskPanel(window)
  const subagents = subagentsTab(window)
  await panel.tab(/^Subagents/).click()
  await expect(subagents.tally).toHaveText('3 running')

  // It takes a message straight away, not into the queue, and answers it while they work.
  await expect(bar.send).toBeVisible()
  await bar.field.fill('Anything yet?')
  await bar.field.press('Enter')
  await expect(bar.queued).toHaveCount(0)
  await expect(userMessages).toHaveCount(2)
  await expect(agentReplies).toHaveCount(2)
  await expect(agentReplies.nth(1)).toContainText(MEANWHILE)

  // Each counts its calls and its time as it goes.
  const queries = subagents.header('Profile the checkout queries')
  await expect(queries).toContainText('Running')
  await expect(queries).toContainText(/\d+s · 2 tool calls/)

  // The cache check fails, with the call it was in; the others carry on.
  const cache = subagents.header('Check the cart cache')
  await expect(cache).toContainText('Failed')
  await expect(cache).toContainText(CACHE_FAILED)
  await expect(subagents.tally).toHaveText('2 running1 failed')

  // Stop subagent stops the bisect; the query profile is still running.
  const bisect = subagents.header('Bisect the slowdown')
  await expect(bisect).toContainText('Running')
  await bisect.click({ button: 'right' })
  await contextMenu(window, 'Subagent actions').item('Stop subagent').click()
  await expect(bisect).toContainText('Failed')
  await expect(bisect).toContainText('You stopped the subagent.')
  await expect(subagents.tally).toHaveText('1 running2 failed')
  await expect(queries).toContainText('Running')

  // Once it really ends, it's done, with what it found, and its time stops; the agent reports it on its own.
  await expect(queries).toContainText('Done')
  await expect(queries).toContainText(PROFILED)
  await expect(subagents.tally).toHaveText('1 done2 failed')
  await expect(queries).toContainText(/\d+s · 2 tool calls/)
  const finished = await queries.textContent()
  await expect(agentReplies).toHaveCount(3)
  await expect(agentReplies.nth(2)).toContainText(REPORTED)
  await expect(queries).toHaveText(finished ?? '')
  await expect(list.dot(list.taskRow(TITLE))).toHaveAttribute('data-state', 'waiting')
})

test('background subagents: one still running when the app quits is interrupted on the next launch', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const first = await launch({ agentScript: 'background-subagents', chosenFolder: root })
  await firstRun(first.window).openFolder.click()
  await taskList(first.window).newTask.click()
  const bar = inputBar(first.window)
  await bar.field.fill('Find why the checkout endpoint got slower since 2.3.')
  await bar.field.press('Enter')
  await expect(chat(first.window).agentReplies).toHaveCount(1)
  await taskPanel(first.window)
    .tab(/^Subagents/)
    .click()
  await expect(subagentsTab(first.window).tally).toHaveText('3 running')
  await first.close()

  const second = await launch({ agentScript: 'background-subagents' })
  const list = taskList(second.window)
  await list.taskRow(TITLE).click()
  await taskPanel(second.window)
    .tab(/^Subagents/)
    .click()
  const subagents = subagentsTab(second.window)
  await expect(subagents.tally).toHaveText('3 interrupted')
  await expect(subagents.header('Bisect the slowdown')).toContainText('Interrupted')
  await expect(list.dot(list.taskRow(TITLE))).toHaveAttribute('data-state', 'waiting')
})
