// Typing in a task with a very long history (#413): about 500 messages, 1,300 tool events, 90 subagents, 45 artifacts
// and 40 todos (`./long-history`). Each key reaches the screen both while nothing else happens and while the agent
// works a turn, its tool calls streaming into the chat and the tool log. Before the fix, each event of a turn rendered
// the whole chat and tool log again and laid them out twice over, so keys waited a second or more.
//
// How prompt a key is is measured, not asserted here: the stress spec `./stress/typing-paint.spec.ts` (run with
// `GLADE_E2E_STRESS=1 npx playwright test e2e/stress/typing-paint.spec.ts`) prints the medians and holds the budget
// (#746). This spec checks the behaviour: typing at a steady pace (`./typing`) keeps every keystroke in the input, and
// the turn's events reach the panels around the input while it types.
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { HISTORY_PAGE } from '../src/shared/bridge'
import {
  HUB_CHILDREN_UNDER_FIRST,
  LONG_HISTORY,
  LONG_TASK_TITLE,
  SelectedHistory,
  writeLongHistorySeed,
} from './long-history'
import { agentsTab, chat, inputBar, taskHeader, taskPanel, todoHub } from './selectors'
import { TEXT, typeText } from './typing'

test('typing stays prompt in a task with a very long history, idle and while the agent works', async ({
  launch,
  tempFolder,
}) => {
  test.setTimeout(120_000)
  const seed = writeLongHistorySeed(tempFolder(), SelectedHistory.Long)
  const { window } = await launch({ seed, agentScript: 'multi-tool-turn' })
  await expect(taskHeader(window).title).toHaveText(LONG_TASK_TITLE)
  // The chat shows the tail first (#637): the last screenful of messages, older history loading as you scroll up.
  await expect(chat(window).userMessages).toHaveCount(HISTORY_PAGE / 2)
  await expect(chat(window).agentReplies).toHaveCount(HISTORY_PAGE / 2)
  await expect(taskPanel(window).tab(/^Agents/)).toHaveText(`Agents ${String(LONG_HISTORY.subagents + 1)}`)

  await typesThroughATurn(window)
})

/** Types a message while nothing else happens, then another while the agent works a turn: every keystroke lands. */
async function typesThroughATurn(window: Page): Promise<void> {
  const bar = inputBar(window)
  await bar.field.click()

  await typeText(window, TEXT)
  await expect(bar.field).toHaveValue(TEXT)

  // A turn: its notes, tool calls and status changes arrive as you type the next message.
  await bar.field.fill('Check the date test.')
  await bar.field.press('Enter')
  await expect(bar.stop).toBeVisible()
  await typeText(window, TEXT)
  await expect(bar.field).toHaveValue(TEXT)
  await expect(chat(window).agentReplies).toHaveCount(HISTORY_PAGE / 2 + 1)
}

// The same task with the Agents tab open on it (P16, #536), which the panel shows in place of the old Tool calls,
// Subagents and Watchers tabs: a tab for Main and its 2 still-running subagents, the caret counting its 88 finished
// ones, and Main's list, the tail of the
// tool log of the task's own agent, older pages loading as you scroll up (#637). Every event of the turn reaches
// them; a tab renders only when its own agent's name or state changed, and a row only when its own event did, so
// typing never waits on them. (The test above waits on the Agents tab's count instead, as a plainer check that the
// same history loaded.)
test('typing stays prompt with the Agents tab open on a task with a very long history', async ({
  launch,
  tempFolder,
}) => {
  test.setTimeout(120_000)
  const seed = writeLongHistorySeed(tempFolder(), SelectedHistory.Long, 'agents', true)
  const { window } = await launch({ seed, agentScript: 'multi-tool-turn' })
  await expect(taskHeader(window).title).toHaveText(LONG_TASK_TITLE)
  await expect(chat(window).agentReplies).toHaveCount(HISTORY_PAGE / 2)
  const panel = taskPanel(window)
  const agents = agentsTab(window)
  await expect(panel.tabs).toHaveCount(3)
  await expect(panel.tab(/^Agents/)).toHaveText(`Agents ${String(LONG_HISTORY.subagents + 1)}`)
  // The seed's 2 still-running subagents are tabs with Main; the other 88 finished ones are counted on the caret's
  // dropdown (#617), so they still all load.
  await expect(agents.tabs).toHaveCount(3)
  await expect(agents.caret).toHaveText(String(LONG_HISTORY.subagents - 2))
  await expect(agents.tab('Main')).toHaveAttribute('aria-selected', 'true')
  // Main's list is there, with the subagent calls of the tail it shows first (#637) — the older ones join as their
  // pages load — while the tabs and the caret still count every subagent, whose call is sent whole however old.
  const calls = agents.list.locator('[data-agent-call]')
  expect(await calls.count()).toBeGreaterThan(0)
  expect(await calls.count()).toBeLessThan(LONG_HISTORY.subagents)

  await typesThroughATurn(window)
  await expect(agents.tab('Main')).toHaveAttribute('aria-selected', 'true')
})

// The same task with the todo hub open on it (P16, #497): 40 todos, each a card, three of them open, the first over 50
// tiles (files and links), with 30 subagents working on it, two of them still running, and none of them a tile (#535),
// and each todo's title naming a PR the task has as a link, so each is a link to it (#500). Every event of the turn
// reaches the hub, which works out each todo's children again; a card or a tile renders only when its own data
// changed, so typing never waits on it.
test('typing stays prompt with the todo hub open on a task with a very long history', async ({
  launch,
  tempFolder,
}) => {
  test.setTimeout(120_000)
  const seed = writeLongHistorySeed(tempFolder(), SelectedHistory.Long, 'todos', true)
  const { window } = await launch({ seed, agentScript: 'multi-tool-turn' })
  await expect(taskHeader(window).title).toHaveText(LONG_TASK_TITLE)
  await expect(chat(window).agentReplies).toHaveCount(HISTORY_PAGE / 2)
  const hub = todoHub(window)
  await expect(hub.cards).toHaveCount(LONG_HISTORY.todos)
  await expect(hub.tiles(hub.cards.first())).toHaveCount(HUB_CHILDREN_UNDER_FIRST)
  await expect(hub.activity).toHaveCount(0)
  await expect(hub.cards.locator('[data-todo-head][aria-expanded="true"]')).toHaveCount(3)
  await expect(hub.links(hub.heads)).toHaveCount(LONG_HISTORY.todos)

  await typesThroughATurn(window)
  await expect(hub.links(hub.heads)).toHaveCount(LONG_HISTORY.todos)
})
