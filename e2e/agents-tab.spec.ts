// The Agents tab (P16, #536), end to end with the hidden `todoHubEnabled` setting on: the right panel's three tabs, a
// tab for every agent in the task, each agent's tool calls, the line that names a subagent's todo, what pointed at the
// Tool calls tab pointing here, the keyboard, and the agent a task was left on across tasks and a relaunch. Then, with
// the scripted agent, the switch turned on mid-task and a subagent's tab moving as it finishes.
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { CommandName } from '../src/shared/bridge'
import { expect, test } from './fixtures'
import { agentsTab, chat, firstRun, inputBar, taskHeader, taskList, taskPanel, todoHub } from './selectors'
import { invoke } from './task-view'

/** The Agents tab's sample task (screens 50, 51 and 54): Main, a subagent still running and four that finished. */
const AGENTS_SEED = resolve(__dirname, '../scripts/fixtures/agents.json')

const SHIP = 'Ship the rate-limit fixes for 2.5'
const ELSEWHERE = 'Fix flaky login test'

/** The names on the strip's tabs, in order. */
function names(tabs: Locator): Promise<string[]> {
  return tabs.evaluateAll((all) => all.map((tab) => tab.getAttribute('title') ?? ''))
}

/** The names of the strip's tabs whose subagent is running, in order. */
function running(tabs: Locator): Promise<string[]> {
  return tabs.evaluateAll((all) =>
    all.filter((tab) => tab.hasAttribute('data-running')).map((tab) => tab.getAttribute('title') ?? ''),
  )
}

/** The only task's id, as main has it. */
async function onlyTaskId(window: Page): Promise<string> {
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const { tasks } = await invoke(window, CommandName.TasksList, { workspaceId: workspaces[0]?.id ?? '' })
  return tasks[0]?.id ?? ''
}

test('the Agents tab: a tab for every agent with its tool calls, a subagent’s todo, and the agent a task was left on', async ({
  launch,
}) => {
  const glade = await launch({ seed: AGENTS_SEED })
  const { window } = glade
  const panel = taskPanel(window)
  const agents = agentsTab(window)
  await expect(taskHeader(window).title).toHaveText(SHIP)

  // Three tabs, and Agents counts the task's agents, Main among them.
  await expect(panel.tabs).toHaveText(['Agents 6', 'Files', 'Todos 3/4'])
  await expect(panel.tab(/^Agents/)).toHaveAttribute('aria-selected', 'true')

  // Main is pinned first; then the subagent that's running; then the finished ones, the newest first.
  await expect
    .poll(() => names(agents.tabs))
    .toEqual(['Main', 'notes-25', 'fix-501-ci', 'limits-502', 'docs-503', 'fix-501'])
  expect(await running(agents.tabs)).toEqual(['notes-25'])
  await expect(agents.tab('Main')).toHaveAttribute('aria-selected', 'true')

  // Main's tab is the Tool calls tab's list: its calls and notes, each subagent it started an Agent call, live while
  // the subagent runs. It has no line about a todo.
  await expect(agents.list).toContainText('Three issues, so three subagents, one for each todo.')
  await expect(agents.agentCall('notes-25')).toContainText(/Running · \d+m$/)
  await expect(agents.agentCall('fix-501')).toContainText('Done · 28m · Opened PR #511.')
  await expect(agents.list).not.toContainText('tests/test_burst.py')
  await expect(agents.line).toHaveCount(0)

  // An Agent call goes to its subagent's tab: its own calls, with the panel to itself, and the todo it worked on.
  // The tab is past the strip's end, so the strip scrolls to it, with a chevron where there are tabs past it.
  await expect(agents.scroll('right')).toBeVisible()
  await agents.agentCall('fix-501').click()
  await expect(agents.tab('fix-501')).toHaveAttribute('aria-selected', 'true')
  await expect(agents.tab('fix-501')).toBeInViewport({ ratio: 0.9 })
  await expect(agents.scroll('left')).toBeVisible()
  await expect(agents.agentPanel).toHaveAccessibleName(/fix-501$/)
  await expect(agents.line).toHaveText(/^Worked on #501 Return Retry-After on 429sDone · 28m$/)
  await expect(panel.call(/pytest tests\/test_burst\.py -v/)).toHaveCount(2)
  await expect(agents.list.getByRole('img', { name: 'Failed' })).toHaveCount(1)
  await panel.call(/Bash\s*pytest -q/).click()
  await expect(agents.list.getByLabel('Bash output')).toContainText('412 passed')
  // Main stays where it is while the rest scroll.
  await expect(agents.tab('Main')).toBeInViewport({ ratio: 0.9 })

  // The strip is one tab stop: ← and → pick the agent before and after, wrapping at the ends.
  await agents.tab('fix-501').focus()
  await window.keyboard.press('ArrowLeft')
  await expect(agents.tab('docs-503')).toHaveAttribute('aria-selected', 'true')
  await expect(agents.tab('docs-503')).toBeFocused()
  await window.keyboard.press('ArrowRight')
  await window.keyboard.press('ArrowRight')
  await expect(agents.tab('Main')).toHaveAttribute('aria-selected', 'true')
  await expect(agents.tab('Main')).toBeFocused()
  await window.keyboard.press('ArrowRight')
  await expect(agents.tab('notes-25')).toBeFocused()
  await window.keyboard.press('Tab')
  await expect(agents.strip.locator(':focus')).toHaveCount(0)

  // A running subagent's tab says what it's working on; the todo's title goes to that todo in the Todos tab.
  await expect(agents.line).toHaveText(/^Working on Draft the 2\.5 release notesRunning · \d+m$/)
  await expect(agents.list).toContainText('python scripts/changelog.py --since v2.4.0')
  await agents.todoLink.click()
  await expect(panel.tab(/^Todos/)).toHaveAttribute('aria-selected', 'true')
  await expect(todoHub(window).head('Draft the 2.5 release notes')).toBeFocused()

  // ⌘⌥1–3 pick the three tabs; ⌘⌥5, which picked Subagents, picks nothing.
  await window.keyboard.press('Meta+Alt+Digit1')
  await expect(panel.tab(/^Agents/)).toHaveAttribute('aria-selected', 'true')
  await expect(agents.tab('notes-25')).toHaveAttribute('aria-selected', 'true')
  await window.keyboard.press('Meta+Alt+Digit2')
  await expect(panel.tab('Files')).toHaveAttribute('aria-selected', 'true')
  await window.keyboard.press('Meta+Alt+Digit5')
  await expect(panel.tab('Files')).toHaveAttribute('aria-selected', 'true')

  // The chat's tool-calls chip shows Main's tab.
  await chat(window)
    .agentReplies.last()
    .getByRole('button', { name: /tool calls$/ })
    .click()
  await expect(panel.tab(/^Agents/)).toHaveAttribute('aria-selected', 'true')
  await expect(agents.tab('Main')).toHaveAttribute('aria-selected', 'true')
  await expect(agents.list).toContainText('Three issues, so three subagents, one for each todo.')

  // Each task is on the agent it was left on: across tasks, and after a relaunch.
  await agents.tab('limits-502').click()
  await expect(agents.line).toHaveText(/^Worked on #502 Per-key limits for \/searchDone · 32m$/)
  await taskList(window).row('Active', ELSEWHERE).click()
  await expect(taskHeader(window).title).toHaveText(ELSEWHERE)
  await expect(panel.tabs).toHaveText(['Agents 1', 'Files', 'Todos'])
  await expect.poll(() => names(agents.tabs)).toEqual(['Main'])
  await taskList(window).row('Active', SHIP).click()
  await expect(taskHeader(window).title).toHaveText(SHIP)
  await expect(agents.tab('limits-502')).toHaveAttribute('aria-selected', 'true')

  await glade.close()
  const relaunched = await launch()
  await expect(taskHeader(relaunched.window).title).toHaveText(SHIP)
  const again = agentsTab(relaunched.window)
  await expect(again.tab('limits-502')).toHaveAttribute('aria-selected', 'true')
  await expect(again.line).toHaveText(/^Worked on #502 Per-key limits for \/search/)
  await expect(again.list).toContainText('pytest tests/test_search_limits.py')
})

// What the background-subagents agent says (`BACKGROUND_SUBAGENTS` in src/main/agent/scripts.ts).
const STARTED = "I've started three subagents on the slow checkout. I'll report back as they finish."
const PROFILED = 'Checkout runs one query per cart item: an N+1 in load_cart.'
const BISECT = 'Bisect the slowdown'
const CACHE = 'Check the cart cache'
const QUERIES = 'Profile the checkout queries'

test('the Agents tab: the switch turned on mid-task, and a subagent’s tab moving to the finished ones as it ends', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'background-subagents', chosenFolder: root })
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  await inputBar(window).field.fill('Find why the checkout endpoint got slower since 2.3.')
  await inputBar(window).field.press('Enter')
  await expect(chat(window).agentReplies.first()).toContainText(STARTED)
  const panel = taskPanel(window)
  const agents = agentsTab(window)

  // With the switch off, the panel is today's seven tabs, with no strip of agents.
  await expect(panel.tabs).toHaveCount(7)
  await expect(panel.tab(/^Tool calls/)).toHaveAttribute('aria-selected', 'true')
  await expect(agents.strip).toHaveCount(0)

  // Turned on while the task runs, the panel is the three tabs, on Agents, with a tab for each agent it has.
  await invoke(window, CommandName.SettingsUpdate, { patch: { todoHubEnabled: true } })
  await expect(panel.tabs).toHaveText(['Agents 4', 'Files', 'Todos'])
  await expect(panel.tab(/^Agents/)).toHaveAttribute('aria-selected', 'true')
  await expect(agents.tab('Main')).toHaveAttribute('aria-selected', 'true')
  await expect(agents.tabs).toHaveCount(4)

  // The bisect runs until it's stopped: the newest of the running ones, so first after Main. It was started for no
  // todo, so its tab has no line.
  const bisect = agents.tab(BISECT)
  await expect(bisect).toHaveAttribute('data-running', '')
  expect((await names(agents.tabs)).slice(0, 2)).toEqual(['Main', BISECT])
  await agents.agentCall(BISECT).click()
  await expect(bisect).toHaveAttribute('aria-selected', 'true')
  await expect(agents.line).toHaveCount(0)
  await expect(agents.list).toContainText('git bisect')

  // It ends: its tab goes after every running one, still the one showing, with its list as it was.
  const toolUseId = (await bisect.getAttribute('data-agent')) ?? ''
  await invoke(window, CommandName.SubagentsStop, { taskId: await onlyTaskId(window), toolUseId })
  await expect(bisect).not.toHaveAttribute('data-running')
  await expect(bisect).toHaveAttribute('aria-selected', 'true')
  await expect(agents.list).toContainText('git bisect')
  await expect
    .poll(async () => {
      const order = await names(agents.tabs)
      const live = await running(agents.tabs)
      return order.slice(1, 1 + live.length).join() === live.join() && order[1 + live.length] === BISECT
    })
    .toBe(true)

  // Once the rest have ended too, the finished ones are the newest first, and Main's list says how each ended.
  await expect.poll(() => running(agents.tabs), { timeout: 20_000 }).toEqual([])
  expect(await names(agents.tabs)).toEqual(['Main', BISECT, CACHE, QUERIES])
  await agents.tab('Main').click()
  await expect(agents.agentCall(BISECT)).toContainText(/Failed · \d+s · You stopped the subagent\./)
  await expect(agents.agentCall(QUERIES)).toContainText(/Done · \d+s · /)
  await expect(agents.agentCall(QUERIES)).toContainText(PROFILED)

  // And its call goes to its tab: its own two calls.
  await agents.agentCall(QUERIES).click()
  await expect(agents.tab(QUERIES)).toHaveAttribute('aria-selected', 'true')
  await expect(panel.call(/Read|Bash/)).toHaveCount(2)
  await expect(agents.list).toContainText('load_cart runs a query per cart item.')
})
