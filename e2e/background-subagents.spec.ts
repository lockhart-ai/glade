import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BACKGROUND_SUBAGENTS, STOP_SPARES_BACKGROUND } from '../src/main/agent/scripts'
import { expect, test } from './fixtures'
import { agentsTab, chat, contextMenu, firstRun, inputBar, taskList, taskPanel } from './selectors'

// What the background-subagents agent says (`BACKGROUND_SUBAGENTS` in src/main/agent/scripts.ts). Running until they
// really end while the parent takes messages, each tab moving as its subagent finishes, and a running subagent's
// Agent call saying what it's doing now are covered by `agents-tab.spec.ts` and `agents-watchers.spec.ts`; this file
// covers what a quit and a Stop leave running.
const TITLE = 'Find why checkout is slow'
const QUERIES = 'Profile the checkout queries'

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
    .tab(/^Agents/)
    .click()
  const firstAgents = agentsTab(first.window)
  await expect(firstAgents.tabs).toHaveCount(4)
  await expect(firstAgents.agentCall(QUERIES)).toContainText(/Running · \d+s/)
  await expect(firstAgents.agentCall(QUERIES).getByTitle(BACKGROUND_SUBAGENTS.queriesSummary)).toBeVisible()
  await first.close()

  const second = await launch({ agentScript: 'background-subagents' })
  const list = taskList(second.window)
  await list.taskRow(TITLE).click()
  await taskPanel(second.window)
    .tab(/^Agents/)
    .click()
  const agents = agentsTab(second.window)
  await expect(agents.agentCall('Bisect the slowdown')).toContainText('Interrupted')
  await expect(agents.agentCall(QUERIES)).toContainText('Interrupted')
  // What it was doing when the app quit goes with it.
  await expect(agents.agentCall(QUERIES).getByTitle(BACKGROUND_SUBAGENTS.queriesSummary)).toHaveCount(0)
  // They ended with the app, so the task no longer counts as working: its reply read, it's idle.
  await expect(list.dot(list.taskRow(TITLE))).toHaveAttribute('data-state', 'idle')
})

test('background subagents: Stop on a turn leaves a background subagent and a watcher running, each stoppable from its tab', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'stop-spares-background', chosenFolder: root })
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  const bar = inputBar(window)
  await bar.field.fill(STOP_SPARES_BACKGROUND.prompt)
  await bar.field.press('Enter')
  const { agentReplies } = chat(window)
  await expect(agentReplies.first()).toContainText(STOP_SPARES_BACKGROUND.started)

  // The next turn runs a long benchmark, and you stop it.
  await bar.field.fill(STOP_SPARES_BACKGROUND.next)
  await bar.field.press('Enter')
  await expect(bar.stop).toBeVisible()
  await bar.stop.click()
  await expect(bar.stop).toHaveCount(0)
  await expect(bar.send).toBeVisible()

  // Only the turn stopped: the subagent and the watcher started before it are still running.
  const panel = taskPanel(window)
  const agents = agentsTab(window)
  await panel.tab(/^Agents/).click()
  await expect(agents.tab(STOP_SPARES_BACKGROUND.bisect)).toHaveAttribute('data-running', '')
  await expect(agents.pinnedWatcher(STOP_SPARES_BACKGROUND.ci)).toBeVisible()

  // Each still stops from its own tab.
  await agents.stopWatcher(STOP_SPARES_BACKGROUND.ci).click()
  await expect(agents.endedWatcher(STOP_SPARES_BACKGROUND.ci)).toHaveAttribute('data-state', 'stopped')
  await agents.tab(STOP_SPARES_BACKGROUND.bisect).click({ button: 'right' })
  await contextMenu(window, 'Subagent actions').item('Stop subagent').click()
  await expect(agents.agentCall(STOP_SPARES_BACKGROUND.bisect)).toContainText('Failed')
  await expect(agents.agentCall(STOP_SPARES_BACKGROUND.bisect)).toContainText('You stopped the subagent.')
})
