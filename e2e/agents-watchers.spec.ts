// Watchers in the Agents tab (P16, #537), end to end with the scripted agent: a live watcher pinned under the tool
// calls of the agent that started it, with Stop; an ended one as a row of that agent's list at the time it ended;
// the eye on the agent's tab; what a relaunch leaves; and a list that stays where it is, for someone reading back,
// as a watcher moves into it. Then what the Agents tab took over from the old Subagents tab: a subagent's tab menu,
// and what a running subagent is doing now.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import {
  BACKGROUND_SUBAGENTS,
  SUBAGENT_BACKGROUND_WORK as WORK,
  WATCHES_THINGS as WATCHES,
} from '../src/main/agent/scripts'
import { desktop, expect, test } from './fixtures'
import { agentsTab, chat, contextMenu, firstRun, inputBar, taskList, taskPanel } from './selectors'

/** The labels of some pinned watchers' cards, or ended watchers' rows, top to bottom. */
function labels(watchers: Locator): Promise<(string | null)[]> {
  return watchers.evaluateAll((all) => all.map((each) => each.getAttribute('aria-label')))
}

/** How far a scroller is from its end, in pixels. */
function fromBottom(scroller: Locator): Promise<number> {
  return scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)
}

test('watchers in the Agents tab: pinned while live with Stop, a row once ended, the eye, and what a relaunch leaves', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const first = await launch({ agentScript: 'watches-things', chosenFolder: root })
  const { window } = first
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  await inputBar(window).field.fill(WATCHES.prompt)
  await inputBar(window).field.press('Enter')

  // The agent starts a monitor, two background commands, a wakeup and a cron job; then the monitor reports twice, the
  // docs build fails and the job fires, a turn each.
  await expect(chat(window).agentReplies).toHaveCount(5, { timeout: 30_000 })
  await expect(chat(window).agentReplies.last()).toContainText(WATCHES.lintPassed)
  const panel = taskPanel(window)
  const agents = agentsTab(window)
  await expect(panel.tabs).toHaveText(['Agents 1', 'Files', 'Todos'])
  await expect(agents.tab('Main')).toHaveAttribute('aria-selected', 'true')

  // What's live is pinned under Main's tool calls, in the order it started, outside the list that scrolls.
  await expect(agents.pinnedWatchers).toHaveCount(4)
  expect(await labels(agents.pinnedWatchers)).toEqual([WATCHES.ci, WATCHES.tests, WATCHES.rollout, WATCHES.queue])
  await expect(agents.watching).toContainText('Watching')
  await expect(agents.list.getByRole('group', { name: 'Watching' })).toHaveCount(0)

  // The monitor: what it runs, the last line it reported, and its two wakes. A process runs, so it's live.
  const ci = agents.pinnedWatcher(WATCHES.ci)
  await expect(ci).toHaveAttribute('data-state', 'running')
  await expect(ci).toContainText(/Running · \d+s/)
  await expect(ci).toContainText(`Monitor${WATCHES.ciCommand}`)
  await expect(ci).toContainText('lastlint')
  await expect(ci).toContainText(/2 wakes · last \d\d:\d\d · since \d\d:\d\d/)
  // The wakeup and the job are only scheduled: pinned the same way, with when they're due.
  const rollout = agents.pinnedWatcher(WATCHES.rollout)
  await expect(rollout).toHaveAttribute('data-state', 'scheduled')
  await expect(rollout).toContainText(/Due in \d+m/)
  await expect(rollout).toContainText(`Wakeup${WATCHES.rolloutPrompt}`)
  await expect(rollout).toContainText(/at \d\d:\d\d · 0 wakes · set \d\d:\d\d/)
  const queue = agents.pinnedWatcher(WATCHES.queue)
  await expect(queue).toContainText(`Cron${WATCHES.queueSchedule}`)
  await expect(queue).toContainText(/next 09:00 · 1 wake · last \d\d:\d\d/)

  // The eye on Main's tab counts all four, and is live.
  await expect(agents.eye('Main')).toHaveText('4')
  await expect(agents.eye('Main')).toHaveAccessibleName('4 watching')
  await expect(agents.eye('Main')).toHaveAttribute('data-live', '')

  // The docs build failed: it left the bottom, and is a row of the list where it ended, in pink, followed by the
  // turn the agent took on being woken. The calls that started the watchers aren't rows.
  await expect(agents.endedWatchers).toHaveCount(1)
  const docs = agents.endedWatcher(WATCHES.docs)
  await expect(docs).toHaveAttribute('data-state', 'failed')
  await expect(docs).toContainText(`Command${WATCHES.docs}`)
  await expect(docs).toContainText(/Failed · ran \d+s · woke the agent once/)
  await expect(docs).toContainText(`end${WATCHES.docsFailed}`)
  await expect(docs.getByRole('img', { name: 'Watcher' })).toBeVisible()
  const order = await agents.rows.evaluateAll((rows) =>
    rows.map((row) => row.getAttribute('aria-label') ?? row.querySelector('[aria-label]')?.getAttribute('aria-label')),
  )
  const at = order.indexOf(`Command ${WATCHES.docs}`)
  expect(order[at - 1]).toMatch(/^turn 2 · /)
  expect(order[at + 1]).toMatch(/^turn 3 · /)
  for (const hidden of ['CronCreate', 'ScheduleWakeup', WATCHES.tests, WATCHES.ciCommand]) {
    await expect(agents.list).not.toContainText(hidden)
  }

  // Stop stops the monitor: it leaves the bottom for the end of the list, grey, saying who stopped it.
  await agents.stopWatcher(WATCHES.ci).click()
  await expect(agents.pinnedWatchers).toHaveCount(3)
  await expect(agents.endedWatchers).toHaveCount(2)
  const stopped = agents.endedWatcher(WATCHES.ci)
  await expect(stopped).toHaveAttribute('data-state', 'stopped')
  await expect(stopped).toContainText(/Stopped · ran \d+s · woke the agent 2 times/)
  await expect(stopped).toContainText('endYou stopped it.')
  await expect(agents.rows.last()).toContainText(`Monitor${WATCHES.ci}`)
  await expect(agents.eye('Main')).toHaveText('3')
  await expect(agents.eye('Main')).toHaveAttribute('data-live', '')

  // With the tests stopped too, nothing runs: the eye is grey, over what's only scheduled.
  await agents.stopWatcher(WATCHES.tests).click()
  await expect(agents.pinnedWatchers).toHaveCount(2)
  await expect(agents.eye('Main')).toHaveText('2')
  await expect(agents.eye('Main')).not.toHaveAttribute('data-live')

  // A relaunch: the wakeup died with the session, so it's a row; the job waits for its session, still pinned.
  await first.kill()
  const second = await launch({ agentScript: 'still-watching' })
  const again = agentsTab(second.window)
  await expect(chat(second.window).agentReplies).toHaveCount(5)
  await expect(again.tab('Main')).toHaveAttribute('aria-selected', 'true')
  await expect(again.pinnedWatchers).toHaveCount(1)
  await expect(again.pinnedWatcher(WATCHES.queue)).toHaveAttribute('data-state', 'suspended')
  await expect(again.pinnedWatcher(WATCHES.queue)).toContainText('Suspended')
  await expect(again.pinnedWatcher(WATCHES.queue)).toContainText('back when the session resumes · 1 wake')
  await expect(again.eye('Main')).toHaveText('1')
  await expect(again.eye('Main')).not.toHaveAttribute('data-live')
  await expect(again.endedWatchers).toHaveCount(4)
  await expect(again.endedWatcher(WATCHES.rollout)).toHaveAttribute('data-state', 'stopped')
  await expect(again.endedWatcher(WATCHES.rollout)).toContainText('endStopped by the relaunch.')
  await expect(again.endedWatcher(WATCHES.ci)).toContainText('endYou stopped it.')
  await expect(again.endedWatcher(WATCHES.docs)).toHaveAttribute('data-state', 'failed')

  // Your next message resumes the session, which has the job back: scheduled again, and due.
  await inputBar(second.window).field.fill('Anything yet?')
  await inputBar(second.window).field.press('Enter')
  await expect(chat(second.window).agentReplies).toHaveCount(6)
  await expect(again.pinnedWatcher(WATCHES.queue)).toHaveAttribute('data-state', 'scheduled')
  await expect(again.pinnedWatcher(WATCHES.queue)).toContainText(/Due in \d+h \d\dm/)
})

test('a subagent’s watcher is on its own tab, with the eye, and its tab’s menu copies its log and stops it', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ agentScript: 'subagent-background-work', chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  await inputBar(window).field.fill(WORK.prompt)
  await inputBar(window).field.press('Enter')
  await expect(chat(window).agentReplies.first()).toContainText(WORK.started)
  const agents = agentsTab(window)

  // Main watches the deploy log; the subagent's lint and e2e suite are its own, counted on its own tab.
  await expect(agents.pinnedWatchers).toHaveCount(1)
  expect(await labels(agents.pinnedWatchers)).toEqual([WORK.deploy])
  await expect(agents.eye('Main')).toHaveText('1')
  await expect(agents.eye(WORK.subagent)).toHaveText('1')
  await expect(agents.eye(WORK.subagent)).toHaveAttribute('data-live', '')

  // On its tab: the e2e suite pinned, the lint a row where it finished, before what it said next; its foreground
  // unit tests are an ordinary call.
  await agents.agentCall(WORK.subagent).click()
  await expect(agents.tab(WORK.subagent)).toHaveAttribute('aria-selected', 'true')
  await expect(agents.list).toContainText(WORK.waiting)
  expect(await labels(agents.pinnedWatchers)).toEqual([WORK.e2e])
  await expect(agents.pinnedWatcher(WORK.e2e)).toContainText(`Command${WORK.e2eCommand}`)
  await expect(agents.endedWatchers).toHaveCount(1)
  const lint = agents.endedWatcher(WORK.lint)
  await expect(lint).toHaveAttribute('data-state', 'finished')
  await expect(lint).toContainText(/Finished · ran \d+s · didn’t wake the agent/)
  await expect(lint).toContainText(`end${WORK.lintDone}`)
  await expect(taskPanel(window).call(/npm test -- api\/checkout/)).toHaveCount(1)
  const rows = await agents.rows.evaluateAll((all) => all.map((row) => row.textContent))
  const lintAt = rows.findIndex((row) => row.includes(WORK.lint))
  expect(rows[lintAt + 1]).toContain(WORK.waiting)
  expect(rows.slice(0, lintAt).some((row) => row.includes(WORK.unitTestsCommand))).toBe(true)

  // The tab's menu, on a right-click and from the keyboard: Copy log, and Stop subagent while it runs.
  const menu = contextMenu(window, 'Subagent actions')
  await agents.tab(WORK.subagent).focus()
  await window.keyboard.press('Shift+F10')
  await expect(menu.items).toHaveText(['Copy log', 'Stop subagent'])
  await window.keyboard.press('Escape')
  await expect(menu.menu).toHaveCount(0)
  await agents.tab(WORK.subagent).click({ button: 'right' })
  await menu.item('Copy log').click()
  await expect
    .poll(async () => (await desktop(glade)).copied.at(-1))
    .toContain(`${WORK.subagent}\nReproducing the flaky test first.`)
  // Main's tab has none.
  await agents.tab('Main').click({ button: 'right' })
  await expect(menu.menu).toHaveCount(0)

  // Stop subagent ends it, and what it left running with it: the watcher is a row of its list, on its tab still.
  await agents.tab(WORK.subagent).click({ button: 'right' })
  await menu.item('Stop subagent').click()
  await expect(agents.tab(WORK.subagent)).not.toHaveAttribute('data-running')
  await expect(agents.tab(WORK.subagent)).toHaveAttribute('aria-selected', 'true')
  await expect(agents.eye(WORK.subagent)).toHaveCount(0)
  await expect(agents.watching).toHaveCount(0)
  await expect(agents.endedWatchers).toHaveCount(2)
  await expect(agents.endedWatcher(WORK.e2e)).toHaveAttribute('data-state', 'stopped')
  await expect(agents.endedWatcher(WORK.e2e)).toContainText('endEnded with its subagent.')
  await agents.tab(WORK.subagent).click({ button: 'right' })
  await expect(menu.items).toHaveText(['Copy log'])
  await window.keyboard.press('Escape')
  // The task's own runs on, on Main's tab.
  await agents.tab('Main').click()
  await expect(agents.eye('Main')).toHaveText('1')
  expect(await labels(agents.pinnedWatchers)).toEqual([WORK.deploy])
  await expect(agents.agentCall(WORK.subagent)).toContainText('You stopped the subagent.')
})

test('a running subagent’s Agent call says what it’s doing now, until it has finished', async ({
  launch,
  tempFolder,
}) => {
  const QUERIES = 'Profile the checkout queries'
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'background-subagents', chosenFolder: root })
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  await inputBar(window).field.fill('Find why the checkout endpoint got slower since 2.3.')
  await inputBar(window).field.press('Enter')
  await expect(chat(window).agentReplies.first()).toContainText(BACKGROUND_SUBAGENTS.started)
  const agents = agentsTab(window)

  await expect(agents.agentCall(QUERIES)).toContainText(/Running · \d+s/)
  await expect(agents.agentCall(QUERIES).getByTitle(BACKGROUND_SUBAGENTS.queriesSummary)).toHaveText(
    BACKGROUND_SUBAGENTS.queriesSummary,
  )

  await expect(agents.agentCall(QUERIES)).toContainText(/Done · \d+s · /, { timeout: 20_000 })
  await expect(agents.agentCall(QUERIES)).not.toContainText(BACKGROUND_SUBAGENTS.queriesSummary)
})

test('a watcher that ends doesn’t move the list of someone reading back, and the list follows it at its end', async ({
  launch,
  tempFolder,
}) => {
  const CALLS = 120
  const wakeup = (n: number) => ({
    kind: 'wakeup',
    toolUseId: `use-wake-${String(n)}`,
    label: `Look at deploy ${String(n)} again`,
    detail: `Check whether deploy ${String(n)} finished, and report.`,
    state: 'scheduled',
    minutesAgo: 5 - n,
    dueInMinutes: 20 + n,
  })
  const seed = join(tempFolder(), 'watching.json')
  writeFileSync(
    seed,
    JSON.stringify({
      workspace: { name: 'Acme API', rootPath: '/Users/sample/code/api' },
      panelTab: 'agents',
      tasks: [
        {
          title: 'Roll out the rate limits',
          status: 'Waiting on three deploys',
          minutesAgo: 1,
          selected: true,
          toolEvents: [
            ...Array.from({ length: CALLS }, (_, index) => ({
              kind: 'tool_call',
              name: 'Bash',
              input: { command: `pytest tests/test_${String(index)}.py` },
              output: '14 passed',
              turn: 1,
              minutesAgo: 200 - index,
            })),
            ...[1, 2, 3].map((n) => ({
              kind: 'tool_call',
              name: 'ScheduleWakeup',
              input: { delaySeconds: 1200, reason: `Look at deploy ${String(n)} again` },
              output: 'Next wakeup scheduled.',
              toolUseId: `use-wake-${String(n)}`,
              turn: 1,
              minutesAgo: 5 - n,
            })),
          ],
          watchers: [1, 2, 3].map(wakeup),
        },
      ],
    }),
  )
  const { window } = await launch({ seed })
  const agents = agentsTab(window)
  await expect(agents.pinnedWatchers).toHaveCount(3)
  await expect(taskPanel(window).call(/pytest/)).toHaveCount(CALLS)
  // The list opens at its end, above what's pinned.
  await expect.poll(() => fromBottom(agents.list)).toBeLessThanOrEqual(1)

  // Reading back: a call well up the list, at the top of what shows.
  const reading = taskPanel(window).call(/tests\/test_40\.py/)
  await agents.list.evaluate((list) => {
    list.scrollTop = Math.floor(list.scrollHeight / 3)
  })
  await expect.poll(() => fromBottom(agents.list)).toBeGreaterThan(200)
  await reading.scrollIntoViewIfNeeded()
  const scrollTop = await agents.list.evaluate((list) => list.scrollTop)
  const top = (await reading.boundingBox())?.y

  // A watcher ends: it leaves the bottom, which gives the list its room, and joins the list's end. What you were
  // reading is where it was.
  await agents.stopWatcher('Look at deploy 2 again').click()
  await expect(agents.pinnedWatchers).toHaveCount(2)
  await expect(agents.endedWatchers).toHaveCount(1)
  await expect.poll(() => agents.list.evaluate((list) => list.scrollTop)).toBe(scrollTop)
  await expect.poll(async () => (await reading.boundingBox())?.y).toBe(top)
  await expect(agents.endedWatcher('Look at deploy 2 again')).not.toBeInViewport()

  // At the list's end, it keeps to its end as the next one arrives, which is then in view.
  await agents.list.evaluate((list) => {
    list.scrollTop = list.scrollHeight
  })
  await expect.poll(() => fromBottom(agents.list)).toBeLessThanOrEqual(1)
  await agents.stopWatcher('Look at deploy 3 again').click()
  await expect(agents.endedWatchers).toHaveCount(2)
  await expect.poll(() => fromBottom(agents.list)).toBeLessThanOrEqual(1)
  await expect(agents.endedWatcher('Look at deploy 3 again')).toBeInViewport()
  expect(await labels(agents.pinnedWatchers)).toEqual(['Look at deploy 1 again'])
})
